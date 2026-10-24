// Adaptive Video Downloader — HLS (.m3u8) and DASH (.mpd) manifest support.
//
// Shared by the popup (to list qualities/audio tracks/duration) and the engine
// (to turn a manifest into concrete download tracks). Needs fetch + DOMParser,
// so it runs in the popup, the offscreen document and Firefox's background page.
//
// A resolved "track" is { role, segments, live, playlistUrl, targetDuration }
// where each segment is { url, duration, seq, byterange, key, map }:
//   byterange = { offset, length } | null
//   key       = { method:'AES-128', url, iv:Uint8Array|null } | null
//   map       = init segment { url, byterange } | null (fMP4 / DASH)
(function () {
  const attrRe = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;

  function parseAttrs(str) {
    const out = {};
    let m;
    attrRe.lastIndex = 0;
    while ((m = attrRe.exec(str))) {
      let v = m[2];
      if (v[0] === '"') v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function hexToBytes(hex) {
    const h = hex.replace(/^0x/i, '');
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    const padded = h.padStart(32, '0').slice(-32);
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16);
    return out;
  }

  // Clear-key AES-128 is plain HLS encryption (supported); anything with a
  // DRM key system (Widevine, FairPlay, PlayReady…) is not.
  function isDrmKey(a) {
    const method = (a.METHOD || '').toUpperCase();
    if (method === 'NONE' || !method) return false;
    if (method !== 'AES-128') return true;
    const fmt = (a.KEYFORMAT || 'identity').toLowerCase();
    return fmt !== 'identity';
  }

  function parseRange(str, fallbackOffset) {
    const m = /^(\d+)(?:@(\d+))?$/.exec(String(str || '').trim());
    if (!m) return null;
    return { length: parseInt(m[1], 10), offset: m[2] != null ? parseInt(m[2], 10) : fallbackOffset };
  }

  function bare(u) {
    return String(u || '').split(/[?#]/)[0];
  }

  /* ---------------- HLS ---------------- */

  function parseHls(text, baseUrl) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
    const abs = (u) => new URL(u, baseUrl).href;

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const audios = [];
      let drm = false;
      const seen = new Set();
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttrs(l.slice(18));
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (j >= lines.length) continue;
          const url = abs(lines[j]);
          if (seen.has(url)) continue;
          seen.add(url);
          const res = /^(\d+)x(\d+)$/i.exec(a.RESOLUTION || '');
          variants.push({
            url,
            bandwidth: parseInt(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || '0', 10) || 0,
            width: res ? parseInt(res[1], 10) : 0,
            height: res ? parseInt(res[2], 10) : 0,
            codecs: a.CODECS || '',
            frameRate: parseFloat(a['FRAME-RATE'] || '0') || 0,
            audioGroup: a.AUDIO || '',
          });
        } else if (l.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttrs(l.slice(13));
          if ((a.TYPE || '').toUpperCase() !== 'AUDIO') continue;
          audios.push({
            groupId: a['GROUP-ID'] || '',
            name: a.NAME || '',
            lang: a.LANGUAGE || '',
            isDefault: (a.DEFAULT || '').toUpperCase() === 'YES',
            url: a.URI ? abs(a.URI) : null,
            channels: a.CHANNELS || '',
          });
        } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
          if (isDrmKey(parseAttrs(l.slice(19)))) drm = true;
        }
      }
      variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
      return { kind: 'master', variants, audios, drm };
    }

    const segments = [];
    let targetDuration = 0;
    let mediaSequence = 0;
    let seq = 0;
    let endList = false;
    let playlistType = '';
    let key = null;
    let map = null;
    let drm = false;
    let encrypted = false;
    let pendingDur = 0;
    let pendingRange = null;
    let lastUrl = '';
    let lastEnd = 0;
    let total = 0;

    for (const l of lines) {
      if (l[0] === '#') {
        if (l.startsWith('#EXTINF:')) pendingDur = parseFloat(l.slice(8)) || 0;
        else if (l.startsWith('#EXT-X-BYTERANGE:')) pendingRange = l.slice(17);
        else if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = parseFloat(l.slice(22)) || 0;
        else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = mediaSequence = parseInt(l.slice(22), 10) || 0;
        else if (l.startsWith('#EXT-X-ENDLIST')) endList = true;
        else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = l.slice(21).toUpperCase();
        else if (l.startsWith('#EXT-X-KEY:')) {
          const a = parseAttrs(l.slice(11));
          const method = (a.METHOD || '').toUpperCase();
          if (method === 'NONE') key = null;
          else if (isDrmKey(a)) {
            drm = true;
            key = { method, drm: true };
          } else {
            encrypted = true;
            key = { method: 'AES-128', url: a.URI ? abs(a.URI) : '', iv: a.IV ? hexToBytes(a.IV) : null };
          }
        } else if (l.startsWith('#EXT-X-MAP:')) {
          const a = parseAttrs(l.slice(11));
          map = a.URI ? { url: abs(a.URI), byterange: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null } : null;
        }
        continue;
      }
      const url = abs(l);
      let byterange = null;
      if (pendingRange) {
        const r = parseRange(pendingRange, url === lastUrl ? lastEnd : 0);
        if (r) {
          byterange = r;
          lastUrl = url;
          lastEnd = r.offset + r.length;
        }
      }
      segments.push({ url, duration: pendingDur, seq: seq++, byterange, key, map });
      total += pendingDur;
      pendingDur = 0;
      pendingRange = null;
    }

    return {
      kind: 'media',
      segments,
      duration: total,
      targetDuration,
      mediaSequence,
      endList: endList || playlistType === 'VOD',
      live: !(endList || playlistType === 'VOD'),
      drm,
      encrypted,
      fmp4: segments.some((s) => s.map),
    };
  }

  /* ---------------- DASH ---------------- */

  function kids(el, name) {
    const out = [];
    if (!el) return out;
    for (const c of el.children) if (c.localName === name) out.push(c);
    return out;
  }
  function kid(el, name) {
    return kids(el, name)[0] || null;
  }
  function attr(el, name) {
    return el ? el.getAttribute(name) : null;
  }

  function isoDuration(str) {
    if (!str) return 0;
    const m =
      /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)W)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
        str.trim()
      );
    if (!m) return 0;
    const n = (i) => parseFloat(m[i] || '0');
    return n(1) * 31536000 + n(2) * 2592000 + n(3) * 604800 + n(4) * 86400 + n(5) * 3600 + n(6) * 60 + n(7);
  }

  function applyBase(el, base) {
    const b = kid(el, 'BaseURL');
    if (!b || !b.textContent.trim()) return base;
    try {
      return new URL(b.textContent.trim(), base).href;
    } catch (e) {
      return base;
    }
  }

  function dashRange(str) {
    const m = /^(\d+)-(\d+)$/.exec(String(str || '').trim());
    if (!m) return null;
    const a = parseInt(m[1], 10);
    return { offset: a, length: parseInt(m[2], 10) - a + 1 };
  }

  function frameRateOf(str) {
    if (!str) return 0;
    const [a, b] = String(str).split('/');
    return parseFloat(a) / (parseFloat(b) || 1) || 0;
  }

  function contentTypeOf(as, rep) {
    const ct = attr(as, 'contentType');
    if (ct) return ct;
    const mime = attr(rep, 'mimeType') || attr(as, 'mimeType') || '';
    if (mime) return mime.split('/')[0];
    const codecs = attr(rep, 'codecs') || attr(as, 'codecs') || '';
    if (/avc|hev|hvc|vp0?9|vp8|av01/i.test(codecs)) return 'video';
    if (/mp4a|opus|ac-3|ec-3|vorbis|flac/i.test(codecs)) return 'audio';
    return '';
  }

  // SegmentTemplate attributes inherit Period → AdaptationSet → Representation.
  function mergedTemplate(chain) {
    let found = false;
    const t = {};
    let timeline = null;
    for (const el of chain) {
      const st = kid(el, 'SegmentTemplate');
      if (!st) continue;
      found = true;
      for (const a of st.attributes) t[a.name] = a.value;
      const tl = kid(st, 'SegmentTimeline');
      if (tl) timeline = tl;
    }
    if (!found) return null;
    t.timeline = timeline;
    return t;
  }

  function fillTemplate(tpl, vars) {
    return tpl
      .replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, k, w) => {
        const s = String(vars[k]);
        return w ? s.padStart(parseInt(w, 10), '0') : s;
      })
      .replace(/\$\$/g, '$');
  }

  function dashSegments(rep, chain, base, periodDur) {
    const abs = (u) => new URL(u, base).href;
    const repId = attr(rep, 'id') || '';
    const bandwidth = attr(rep, 'bandwidth') || '0';

    const tpl = mergedTemplate(chain);
    if (tpl && tpl.media) {
      const timescale = parseFloat(tpl.timescale || '1') || 1;
      const startNumber = tpl.startNumber != null ? parseInt(tpl.startNumber, 10) : 1;
      const pto = parseFloat(tpl.presentationTimeOffset || '0') || 0;
      const vars = (num, time) => ({ RepresentationID: repId, Bandwidth: bandwidth, Number: num, Time: time });
      const init = tpl.initialization ? { url: abs(fillTemplate(tpl.initialization, vars(startNumber, 0))), byterange: null } : null;
      const segments = [];
      if (tpl.timeline) {
        const S = kids(tpl.timeline, 'S');
        let t = 0;
        let num = startNumber;
        for (let i = 0; i < S.length; i++) {
          if (attr(S[i], 't') != null) t = parseFloat(attr(S[i], 't'));
          const d = parseFloat(attr(S[i], 'd') || '0');
          if (!d) continue;
          let r = parseInt(attr(S[i], 'r') || '0', 10);
          if (r < 0) {
            const next = S[i + 1] && attr(S[i + 1], 't') != null ? parseFloat(attr(S[i + 1], 't')) : pto + periodDur * timescale;
            r = Math.max(0, Math.ceil((next - t) / d) - 1);
          }
          for (let k = 0; k <= r; k++) {
            segments.push({ url: abs(fillTemplate(tpl.media, vars(num, t))), duration: d / timescale, byterange: null });
            t += d;
            num++;
          }
        }
      } else {
        const d = parseFloat(tpl.duration || '0');
        if (!d) throw new Error('DASH template has no segment duration');
        const count = periodDur > 0 ? Math.ceil((periodDur * timescale) / d - 1e-6) : 0;
        if (!count) throw new Error('DASH stream length is unknown (live?)');
        for (let i = 0; i < count; i++) {
          segments.push({
            url: abs(fillTemplate(tpl.media, vars(startNumber + i, pto + i * d))),
            duration: d / timescale,
            byterange: null,
          });
        }
      }
      return { init, segments };
    }

    let list = null;
    for (const el of chain) list = kid(el, 'SegmentList') || list;
    if (list) {
      const timescale = parseFloat(attr(list, 'timescale') || '1') || 1;
      const dur = parseFloat(attr(list, 'duration') || '0') / timescale;
      const ini = kid(list, 'Initialization');
      const init = ini
        ? { url: attr(ini, 'sourceURL') ? abs(attr(ini, 'sourceURL')) : base, byterange: dashRange(attr(ini, 'range')) }
        : null;
      const segments = kids(list, 'SegmentURL').map((s) => ({
        url: attr(s, 'media') ? abs(attr(s, 'media')) : base,
        duration: dur,
        byterange: dashRange(attr(s, 'mediaRange')),
      }));
      return { init, segments };
    }

    // SegmentBase / bare BaseURL: one self-contained file.
    return { init: null, segments: [{ url: base, duration: periodDur, byterange: null }] };
  }

  function parseDash(text, baseUrl) {
    if (typeof DOMParser === 'undefined') throw new Error('DASH parsing needs a DOM context');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || mpd.localName !== 'MPD' || doc.getElementsByTagName('parsererror').length) {
      throw new Error('Not a DASH manifest');
    }
    const live = attr(mpd, 'type') === 'dynamic';
    const mpdDur = isoDuration(attr(mpd, 'mediaPresentationDuration'));
    const base0 = applyBase(mpd, baseUrl);
    const periods = kids(mpd, 'Period');
    if (!periods.length) throw new Error('DASH manifest has no periods');
    let period = periods[0];
    let periodDur = isoDuration(attr(period, 'duration')) || (periods.length === 1 ? mpdDur : 0);
    if (periods.length > 1) {
      // Multi-period (often ads + main content): take the longest one.
      for (const p of periods) {
        const d = isoDuration(attr(p, 'duration'));
        if (d > periodDur) {
          period = p;
          periodDur = d;
        }
      }
      if (!periodDur) periodDur = mpdDur;
    }
    const baseP = applyBase(period, base0);

    const videos = [];
    const audios = [];
    for (const as of kids(period, 'AdaptationSet')) {
      const asProt = kids(as, 'ContentProtection').length > 0;
      const baseA = applyBase(as, baseP);
      const lang = attr(as, 'lang') || '';
      const labelEl = kid(as, 'Label');
      const asLabel = (labelEl && labelEl.textContent.trim()) || attr(as, 'label') || '';
      for (const rep of kids(as, 'Representation')) {
        const ct = contentTypeOf(as, rep);
        if (ct !== 'video' && ct !== 'audio') continue;
        const baseR = applyBase(rep, baseA);
        const info = {
          repId: attr(rep, 'id') || '',
          bandwidth: parseInt(attr(rep, 'bandwidth') || '0', 10) || 0,
          width: parseInt(attr(rep, 'width') || attr(as, 'width') || '0', 10) || 0,
          height: parseInt(attr(rep, 'height') || attr(as, 'height') || '0', 10) || 0,
          frameRate: frameRateOf(attr(rep, 'frameRate') || attr(as, 'frameRate')),
          codecs: attr(rep, 'codecs') || attr(as, 'codecs') || '',
          mime: attr(rep, 'mimeType') || attr(as, 'mimeType') || '',
          lang,
          name: asLabel,
          drm: asProt || kids(rep, 'ContentProtection').length > 0,
          build: () => dashSegments(rep, [period, as, rep], baseR, periodDur),
        };
        (ct === 'video' ? videos : audios).push(info);
      }
    }
    videos.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
    audios.sort((x, y) => y.bandwidth - x.bandwidth);
    const primary = videos.length ? videos : audios;
    const drm = primary.length > 0 && primary.every((r) => r.drm);
    return {
      kind: 'dash',
      live,
      duration: periodDur || mpdDur,
      videos: videos.filter((v) => !v.drm),
      audios: audios.filter((a) => !a.drm),
      drm,
    };
  }

  /* ---------------- fetching ---------------- */

  async function fetchText(url, opts) {
    const o = opts || {};
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), (o.timeout || 15) * 1000) : null;
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        credentials: o.credentials || 'include',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return { text: await res.text(), url: res.url || url };
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('timed out');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function kindOf(url, text) {
    if (text != null) {
      if (/^\s*#EXTM3U/.test(text)) return 'hls';
      if (/<MPD[\s>]/.test(text)) return 'dash';
    }
    const p = bare(url).toLowerCase();
    if (p.endsWith('.m3u8') || p.endsWith('.m3u')) return 'hls';
    if (p.endsWith('.mpd')) return 'dash';
    return '';
  }

  async function load(url, opts) {
    const { text, url: finalUrl } = await fetchText(url, opts);
    const kind = kindOf(url, text);
    if (kind === 'hls') return { kind, doc: parseHls(text, finalUrl), url: finalUrl };
    if (kind === 'dash') return { kind, doc: parseDash(text, finalUrl), url: finalUrl };
    throw new Error('Unrecognised manifest');
  }

  /* ---------------- description (for the popup) ---------------- */

  function hlsVariantDesc(v) {
    const audioOnly = !v.height && /mp4a|ac-3|ec-3|opus/i.test(v.codecs) && !/avc|hvc|hev|vp0?9|av01/i.test(v.codecs);
    return {
      key: 'u:' + bare(v.url),
      height: v.height,
      width: v.width,
      bandwidth: v.bandwidth,
      frameRate: v.frameRate,
      codecs: v.codecs,
      audioOnly,
    };
  }

  // Summarise a manifest: qualities, audio tracks, duration, live/DRM state.
  async function describe(url, opts) {
    const { kind, doc } = await load(url, opts);
    if (kind === 'hls') {
      if (doc.kind === 'master') {
        const out = {
          type: 'hls',
          isMaster: true,
          drm: doc.drm,
          encrypted: false,
          live: false,
          duration: 0,
          segCount: 0,
          fmp4: false,
          variants: doc.variants.map(hlsVariantDesc),
          audios: doc.audios
            .filter((a) => a.url)
            .map((a) => ({ key: 'a:' + a.groupId + ':' + a.name + ':' + a.lang, name: a.name, lang: a.lang, isDefault: a.isDefault, groupId: a.groupId })),
          childUrls: [...doc.variants.map((v) => bare(v.url)), ...doc.audios.filter((a) => a.url).map((a) => bare(a.url))],
        };
        // Peek at the top variant for duration / live / encryption.
        if (doc.variants[0]) {
          try {
            const media = await load(doc.variants[0].url, opts);
            if (media.kind === 'hls' && media.doc.kind === 'media') {
              out.duration = media.doc.duration;
              out.live = media.doc.live;
              out.segCount = media.doc.segments.length;
              out.encrypted = media.doc.encrypted;
              out.fmp4 = media.doc.fmp4;
              if (media.doc.drm) out.drm = true;
            }
          } catch (e) {
            /* duration stays unknown */
          }
        }
        return out;
      }
      return {
        type: 'hls',
        isMaster: false,
        drm: doc.drm,
        encrypted: doc.encrypted,
        live: doc.live,
        duration: doc.duration,
        segCount: doc.segments.length,
        fmp4: doc.fmp4,
        variants: [],
        audios: [],
      };
    }
    return {
      type: 'dash',
      isMaster: true,
      drm: doc.drm,
      encrypted: false,
      live: doc.live,
      duration: doc.duration,
      segCount: 0,
      fmp4: true,
      variants: doc.videos.map((v) => ({
        key: 'r:' + v.repId,
        height: v.height,
        width: v.width,
        bandwidth: v.bandwidth,
        frameRate: v.frameRate,
        codecs: v.codecs,
      })),
      audios: doc.audios.map((a) => ({ key: 'r:' + a.repId, name: a.name, lang: a.lang, bandwidth: a.bandwidth, codecs: a.codecs })),
    };
  }

  /* ---------------- resolution (for the engine) ---------------- */

  // Pick by exact key, else the closest height/bandwidth, else the best.
  function pick(list, sel, keyOf) {
    if (!list.length) return null;
    if (!sel) return list[0];
    const exact = list.find((x) => keyOf(x) === sel.key);
    if (exact) return exact;
    if (sel.height || sel.bandwidth) {
      let best = list[0];
      let bestScore = Infinity;
      for (const x of list) {
        const s = Math.abs((x.height || 0) - (sel.height || 0)) * 1e7 + Math.abs((x.bandwidth || 0) - (sel.bandwidth || 0));
        if (s < bestScore) {
          bestScore = s;
          best = x;
        }
      }
      return best;
    }
    return list[0];
  }

  function hlsTrack(role, media, playlistUrl) {
    return {
      role,
      segments: media.segments,
      live: media.live,
      playlistUrl,
      targetDuration: media.targetDuration || 6,
      duration: media.duration,
    };
  }

  // sel = { variant:{key,height,bandwidth}|null, audio:{key}|null, audioOnly }
  async function resolve(url, sel, opts) {
    sel = sel || {};
    const { kind, doc, url: finalUrl } = await load(url, opts);
    if (kind === 'hls') {
      if (doc.drm) throw new Error('This stream is DRM-protected');
      if (doc.kind === 'media') {
        if (doc.drm) throw new Error('This stream is DRM-protected');
        return { tracks: [hlsTrack('muxed', doc, finalUrl)], live: doc.live, duration: doc.duration, quality: '' };
      }
      const variant = pick(doc.variants, sel.variant, (v) => 'u:' + bare(v.url));
      if (!variant) throw new Error('Playlist has no playable variants');
      const group = doc.audios.filter((a) => a.groupId === variant.audioGroup && a.url);
      let audio = null;
      if (group.length) {
        audio =
          (sel.audio && group.find((a) => 'a:' + a.groupId + ':' + a.name + ':' + a.lang === sel.audio.key)) ||
          group.find((a) => a.isDefault) ||
          group[0];
      }
      const tracks = [];
      let live = false;
      let duration = 0;
      if (!(sel.audioOnly && audio)) {
        const v = await load(variant.url, opts);
        if (v.kind !== 'hls' || v.doc.kind !== 'media') throw new Error('Variant playlist is invalid');
        if (v.doc.drm) throw new Error('This stream is DRM-protected');
        tracks.push(hlsTrack(audio ? 'video' : 'muxed', v.doc, v.url));
        live = v.doc.live;
        duration = v.doc.duration;
      }
      if (audio) {
        const a = await load(audio.url, opts);
        if (a.kind === 'hls' && a.doc.kind === 'media' && !a.doc.drm) {
          tracks.push(hlsTrack('audio', a.doc, a.url));
          live = live || a.doc.live;
          duration = duration || a.doc.duration;
        }
      }
      if (!tracks.length) throw new Error('No playable tracks');
      return { tracks, live, duration, quality: AVD.qualityLabel(variant) };
    }

    // DASH
    if (doc.drm) throw new Error('This stream is DRM-protected');
    if (doc.live) throw new Error('Live DASH streams aren’t supported yet');
    const tracks = [];
    const video = sel.audioOnly && doc.audios.length ? null : pick(doc.videos, sel.variant, (v) => 'r:' + v.repId);
    const audio = pick(doc.audios, sel.audio, (a) => 'r:' + a.repId);
    if (video) tracks.push(dashTrack(audio ? 'video' : 'muxed', video, doc.duration));
    if (audio) tracks.push(dashTrack('audio', audio, doc.duration));
    if (!tracks.length) throw new Error('No playable tracks');
    return { tracks, live: false, duration: doc.duration, quality: video ? AVD.qualityLabel(video) : 'Audio' };
  }

  function dashTrack(role, rep, duration) {
    const { init, segments } = rep.build();
    return {
      role,
      live: false,
      duration,
      mime: rep.mime,
      codecs: rep.codecs,
      segments: segments.map((s, i) => ({ ...s, seq: i, key: null, map: init })),
    };
  }

  // Keep the segments overlapping [from, to] seconds.
  function sliceByTime(segments, from, to) {
    const lo = isFinite(from) && from > 0 ? from : 0;
    const hi = isFinite(to) && to > 0 ? to : Infinity;
    if (lo === 0 && hi === Infinity) return segments;
    const out = [];
    let t = 0;
    for (const s of segments) {
      const end = t + (s.duration || 0);
      if (end > lo && t < hi) out.push(s);
      t = end;
    }
    return out;
  }

  globalThis.AVD_Manifest = {
    parseHls,
    parseDash,
    fetchText,
    kindOf,
    load,
    describe,
    resolve,
    sliceByTime,
    bare,
  };
})();
