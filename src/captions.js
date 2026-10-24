// Adaptive Video Downloader — captions & subtitles.
//
// Shared by the popup (preview / "save captions now") and the engine (captions
// saved next to — or embedded in — the video). Understands WebVTT, SRT and
// TTML/DFXP, stitches segmented HLS WebVTT playlists back into one track
// (honouring X-TIMESTAMP-MAP), and writes clean .srt or .vtt.
//
// A caption source is one of:
//   { kind:'file', url }            a .vtt/.srt/.ttml file (or DASH text rep)
//   { kind:'hls',  url }            an HLS subtitles media playlist
//   { kind:'text', text }           cues already pulled out of the page
// plus { lang, label } for display and file naming.
(function () {
  function parseTime(t) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(t).trim());
    if (!m) return NaN;
    return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
  }

  function clean(text) {
    // Keep the tags both formats understand; drop voice/class/ruby markup.
    return text
      .replace(/<(?!\/?(i|b|u)>)[^>]*>/gi, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  function parseCues(text, sep) {
    const cues = [];
    let map = null;
    const blocks = String(text || '')
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').filter((l, i) => i > 0 || l.trim());
      if (!lines.length) continue;
      if (/^WEBVTT/.test(lines[0])) {
        const tm = /X-TIMESTAMP-MAP=([^\n]+)/.exec(block);
        if (tm) {
          const mp = /MPEGTS:(\d+)/.exec(tm[1]);
          const lc = /LOCAL:([\d:.]+)/.exec(tm[1]);
          map = { mpegts: mp ? +mp[1] : 0, local: lc ? parseTime(lc[1]) || 0 : 0 };
        }
        continue;
      }
      if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti < 0) continue;
      const [a, b] = lines[ti].split('-->');
      const start = parseTime(a);
      const end = parseTime(String(b).trim().split(/\s+/)[0]);
      if (!isFinite(start) || !isFinite(end)) continue;
      const body = clean(lines.slice(ti + 1).join('\n'));
      if (body) cues.push({ start, end, text: body });
    }
    return { cues, map, sep };
  }

  // TTML/DFXP: <p begin= end=|dur=> with clock (00:00:01.5), offset (1.5s,
  // 300ms) or tick (15000t) times.
  function parseTtml(text) {
    if (typeof DOMParser === 'undefined') return { cues: [] };
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const root = doc.documentElement;
    const tickRate = parseFloat(root.getAttribute('ttp:tickRate') || root.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate') || '10000000');
    const fps = parseFloat(root.getAttribute('ttp:frameRate') || '30');
    const t = (v) => {
      if (!v) return NaN;
      let m = /^([\d.]+)(h|m|s|ms|t|f)$/.exec(v);
      if (m) {
        const n = parseFloat(m[1]);
        return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, t: n / tickRate, f: n / fps }[m[2]];
      }
      m = /^(\d+):(\d{2}):(\d{2})(?:[.:](\d+))?$/.exec(v);
      if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? (v.includes('.') ? parseFloat('0.' + m[4]) : +m[4] / fps) : 0);
      return parseTime(v);
    };
    const textOf = (node) => {
      let s = '';
      for (const c of node.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue.replace(/\s+/g, ' ');
        else if (c.localName === 'br') s += '\n';
        else if (c.nodeType === 1) s += textOf(c);
      }
      return s;
    };
    const cues = [];
    for (const p of doc.getElementsByTagNameNS('*', 'p')) {
      const start = t(p.getAttribute('begin'));
      let end = t(p.getAttribute('end'));
      if (!isFinite(end)) end = start + t(p.getAttribute('dur'));
      const body = textOf(p).split('\n').map((l) => l.trim()).join('\n').trim();
      if (isFinite(start) && isFinite(end) && body) cues.push({ start, end, text: body });
    }
    return { cues };
  }

  function parseAny(text) {
    const s = String(text || '').replace(/^﻿/, '').trimStart();
    if (/^WEBVTT/.test(s)) return parseCues(s);
    if (/^<\?xml|^<tt[\s>]|<tt\s/i.test(s.slice(0, 400))) return parseTtml(s);
    if (/-->/.test(s)) return parseCues(s);
    return { cues: [] };
  }

  function stamp(sec, sep) {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const pad = (n, w) => String(n).padStart(w || 2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
  }

  function toSrt(cues) {
    return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');
  }

  function toVtt(cues) {
    return 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n');
  }

  // HLS WebVTT segments each carry their own X-TIMESTAMP-MAP. Put every cue on
  // the timeline of the first segment, then drop the duplicates that appear
  // when a cue spans a segment boundary.
  function mergeSegments(parsed) {
    const base = (parsed.find((p) => p.map) || {}).map;
    const all = [];
    for (const p of parsed) {
      let shift = 0;
      if (base && p.map) shift = (p.map.mpegts - base.mpegts) / 90000 - (p.map.local - base.local);
      for (const c of p.cues) all.push({ start: c.start + shift, end: c.end + shift, text: c.text });
    }
    return dedupe(all);
  }

  function dedupe(cues) {
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (prev && prev.text === c.text && c.start <= prev.end + 0.05) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      out.push(c);
    }
    return out;
  }

  async function getText(url, opts) {
    return (await AVD_Manifest.fetchText(url, opts)).text;
  }

  // → { cues } for any caption source.
  async function load(c, opts) {
    if (c.kind === 'text') return { cues: dedupe(parseAny(c.text).cues) };
    if (c.kind === 'hls') {
      const r = await AVD_Manifest.load(c.url, opts);
      if (r.kind !== 'hls' || r.doc.kind !== 'media') throw new Error('not a subtitle playlist');
      const segs = r.doc.segments;
      const parsed = new Array(segs.length);
      let next = 0;
      const worker = async () => {
        while (next < segs.length) {
          const i = next++;
          try {
            parsed[i] = parseAny(await getText(segs[i].url, opts));
          } catch (e) {
            parsed[i] = { cues: [] };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, segs.length) }, worker));
      return { cues: mergeSegments(parsed) };
    }
    return { cues: dedupe(parseAny(await getText(c.url, opts)).cues) };
  }

  async function render(c, format, opts) {
    const { cues } = await load(c, opts);
    if (!cues.length) throw new Error('no cues');
    return { text: format === 'vtt' ? toVtt(cues) : toSrt(cues), ext: format === 'vtt' ? 'vtt' : 'srt', count: cues.length, end: cues[cues.length - 1].end };
  }

  /* ---------------- naming ---------------- */

  const CODES = 'en|es|fr|de|it|pt|ru|ja|ko|zh|ar|hi|nl|sv|pl|tr|id|th|vi|he|uk|cs|da|fi|no|nb|el|ro|hu|ms|fil|bn|fa|ta';
  const NAMES = {
    english: 'en', spanish: 'es', espanol: 'es', french: 'fr', francais: 'fr', german: 'de', deutsch: 'de', italian: 'it',
    portuguese: 'pt', russian: 'ru', japanese: 'ja', korean: 'ko', chinese: 'zh', arabic: 'ar', hindi: 'hi', dutch: 'nl',
    turkish: 'tr', polish: 'pl', swedish: 'sv', indonesian: 'id', vietnamese: 'vi', thai: 'th',
  };

  function guessLang(...hints) {
    for (const h of hints) {
      if (!h) continue;
      const s = String(h).toLowerCase();
      const m = /^([a-z]{2,3})(?:[-_][a-z0-9]+)?$/.exec(s);
      if (m) return m[1];
      for (const [name, code] of Object.entries(NAMES)) if (s.includes(name)) return code;
      const f = new RegExp(`(?:^|[._\\-/=])(${CODES})(?:[-_][a-z]{2,4})?(?:[._\\-/&?]|$)`).exec(s.split('#')[0]);
      if (f) return f[1];
    }
    return '';
  }

  let names = null;
  function langName(code) {
    if (!code) return '';
    try {
      names = names || new Intl.DisplayNames(['en'], { type: 'language' });
      return names.of(code) || code;
    } catch (e) {
      return code;
    }
  }

  function labelOf(c) {
    return c.label || langName(c.lang) || 'Captions';
  }

  // ISO 639-2 for MP4 metadata (mov_text wants three letters).
  const ISO3 = { en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'zho', ar: 'ara', hi: 'hin', nl: 'nld', sv: 'swe', pl: 'pol', tr: 'tur', id: 'ind', th: 'tha', vi: 'vie', he: 'heb', uk: 'ukr', cs: 'ces', da: 'dan', fi: 'fin', no: 'nor', nb: 'nob', el: 'ell', ro: 'ron', hu: 'hun' };

  globalThis.AVD_Captions = { parseAny, toSrt, toVtt, mergeSegments, load, render, guessLang, langName, labelOf, iso3: (c) => ISO3[c] || '' };
})();
