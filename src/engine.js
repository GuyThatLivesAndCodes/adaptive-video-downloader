// Adaptive Video Downloader — download engine.
//
// Runs in a PERSISTENT context so downloads keep going (and still save) after
// the toolbar popup closes:
//   • Chrome (MV3): inside an offscreen document (offscreen.html + offscreen.js).
//   • Firefox (MV2): inside the persistent background page.
//
// The engine touches no chrome.* APIs; the host wires up callbacks:
//   AVD_Engine.onState(state)              → publish progress for the popup
//   AVD_Engine.onSave(url, name, saveAs)   → save a blob URL, resolves {ok, id}
//   AVD_Engine.onHeaders(headers|null)     → set/clear Referer/Origin rewriting
//   AVD_Engine.onFinished(record)          → append to download history
// and drives it with AVD_Engine.handleCommand({ seq, action, job?, id? }).
//
// Pipeline per job: resolve source → tracks → download segments through an
// adaptive (AIMD) connection limiter with retries/backoff → decrypt AES-128 →
// prepend init segments → assemble → ffmpeg.wasm remux/mux/extract → save.
(function () {
  const LOG_CAP = 80;
  const RECENT_CAP = 4;
  const FFMPEG_LIMIT = 900 * 1048576; // input + output must fit the 2 GB wasm heap
  const TEMPLATE_CAP = 6000; // hard ceiling for unknown-length seg-N streams
  const ADAPTIVE_MAX = 24;
  const ADAPTIVE_START = 6;
  const CHUNK_SIZE = 4 * 1048576; // ranged parallel download of direct files
  const CHUNK_MIN_FILE = 12 * 1048576;

  class Cancelled extends Error {
    constructor() {
      super('cancelled');
      this.cancelled = true;
    }
  }
  class HttpError extends Error {
    constructor(status, msg, retryAfter) {
      super(msg || 'HTTP ' + status);
      this.status = status;
      this.retryAfter = retryAfter || 0;
    }
  }

  async function nap(ms, ctl) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (ctl && ctl.cancelled) return;
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, end - Date.now()))));
    }
  }

  async function whilePaused(ctl) {
    while (ctl.paused && !ctl.cancelled) await nap(200);
  }

  /* ---------------- state publishing ---------------- */

  let queue = [];
  let cur = null; // running job context
  let lastSeq = 0;
  const S = { active: null, queue: [], recent: [], ts: 0 };

  function publicJob(j) {
    return { id: j.id, title: j.title, site: j.site, thumb: j.thumb || '', quality: j.qualityHint || '' };
  }

  let emitTimer = null;
  function emit(immediate) {
    S.queue = queue.map(publicJob);
    S.ts = Date.now();
    const send = () => {
      emitTimer = null;
      const cb = AVD_Engine.onState;
      if (!cb) return;
      try {
        cb(JSON.parse(JSON.stringify(S)));
      } catch (e) {
        /* host channel not ready */
      }
    };
    if (immediate) {
      if (emitTimer) clearTimeout(emitTimer);
      send();
      return;
    }
    if (!emitTimer) emitTimer = setTimeout(send, 250);
  }

  /* ---------------- adaptive connection limiter (AIMD) ---------------- */
  //
  // Starts at a polite level and grows by ~1 connection per round of
  // successes; any throttling signal (429/503/timeouts) halves it. With a fixed
  // concurrency the limit never moves.

  function makeLimiter(ctl, fixed) {
    let limit = fixed || ADAPTIVE_START;
    const max = fixed || ADAPTIVE_MAX;
    let inflight = 0;
    let lastCut = 0;
    const waiters = [];
    function pump() {
      while (waiters.length && inflight < Math.floor(limit) && !ctl.paused) {
        inflight++;
        waiters.shift()();
      }
    }
    return {
      workers: max,
      get value() {
        return Math.floor(limit);
      },
      acquire() {
        return new Promise((res) => {
          waiters.push(res);
          pump();
        });
      },
      release(kind) {
        inflight = Math.max(0, inflight - 1);
        if (!fixed) {
          if (kind === 'ok') limit = Math.min(max, limit + 1 / Math.max(1, limit));
          else if (kind === 'throttle' && Date.now() - lastCut > 1500) {
            limit = Math.max(1, limit / 2);
            lastCut = Date.now();
          }
        }
        pump();
      },
      pump,
      flush() {
        // release everyone waiting (used on cancel)
        while (waiters.length) {
          inflight++;
          waiters.shift()();
        }
      },
    };
  }

  /* ---------------- HTTP ---------------- */

  async function fetchBytes(ctx, url, byterange, timeoutSec) {
    const ctl = ctx.ctl;
    if (ctl.cancelled) throw new Cancelled();
    const ac = new AbortController();
    ctl.aborters.add(ac);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, (timeoutSec || ctx.opts.timeout || 30) * 1000);
    try {
      const headers = byterange ? { Range: `bytes=${byterange.offset}-${byterange.offset + byterange.length - 1}` } : undefined;
      const res = await fetch(url, { cache: 'no-store', credentials: ctx.credentials, headers, signal: ac.signal });
      if (!res.ok) {
        const ra = parseFloat(res.headers.get('retry-after') || '0') || 0;
        try {
          if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
        } catch (e) {}
        throw new HttpError(res.status, '', ra * 1000);
      }
      let buf = await res.arrayBuffer();
      if (byterange && res.status === 200 && buf.byteLength > byterange.length) {
        buf = buf.slice(byterange.offset, byterange.offset + byterange.length); // server ignored Range
      }
      if (!buf.byteLength) throw new HttpError(0, 'empty response');
      return buf;
    } catch (e) {
      if (ctl.cancelled) throw new Cancelled();
      if (e && e.name === 'AbortError') {
        const err = new HttpError(0, timedOut ? 'timed out' : 'aborted');
        err.timeout = timedOut;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      ctl.aborters.delete(ac);
    }
  }

  const FATAL = new Set([400, 401, 403, 404, 410, 451]);

  // Retries with exponential backoff + jitter, honouring Retry-After. `fatal`
  // statuses fail immediately (used for end-of-stream detection).
  async function fetchRetry(ctx, url, byterange, o) {
    o = o || {};
    const retries = o.retries != null ? o.retries : ctx.opts.retries;
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await whilePaused(ctx.ctl);
      if (ctx.ctl.cancelled) throw new Cancelled();
      try {
        return await fetchBytes(ctx, url, byterange, o.timeout);
      } catch (e) {
        if (e && e.cancelled) throw e;
        last = e;
        const st = e && e.status;
        if (o.fatal && FATAL.has(st)) throw e;
        if (attempt < retries) {
          const backoff = Math.min(8000, 400 * 2 ** attempt) + Math.random() * 300;
          await nap(Math.min(15000, Math.max(backoff, (e && e.retryAfter) || 0)), ctx.ctl);
        }
      }
    }
    throw last || new Error('request failed');
  }

  /* ---------------- AES-128 (clear-key HLS) ---------------- */

  function seqIv(seq) {
    const iv = new Uint8Array(16);
    let n = seq;
    for (let i = 15; i >= 12 && n > 0; i--) {
      iv[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    return iv;
  }

  async function decrypt(ctx, seg, buf) {
    const k = seg.key;
    if (!k || k.method !== 'AES-128') return buf;
    let entry = ctx.keys.get(k.url);
    if (!entry) {
      entry = (async () => {
        const raw = await fetchRetry(ctx, k.url, null, { retries: Math.max(3, ctx.opts.retries) });
        if (raw.byteLength !== 16) throw new Error('invalid AES-128 key length');
        return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      })();
      ctx.keys.set(k.url, entry);
    }
    const key = await entry;
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv: k.iv || seqIv(seg.seq) }, key, buf);
  }

  /* ---------------- progress ---------------- */

  function addBytes(ctx, n) {
    ctx.bytes += n;
    const now = Date.now();
    ctx.samples.push([now, ctx.bytes]);
    while (ctx.samples.length > 2 && now - ctx.samples[0][0] > 5000) ctx.samples.shift();
  }

  function speedOf(ctx) {
    const s = ctx.samples;
    if (s.length < 2) return 0;
    const dt = (s[s.length - 1][0] - s[0][0]) / 1000;
    return dt > 0.2 ? (s[s.length - 1][1] - s[0][1]) / dt : 0;
  }

  function updateProgress(ctx) {
    const a = S.active;
    if (!a || a.id !== ctx.job.id) return;
    const speed = ctx.ctl.paused ? 0 : speedOf(ctx);
    a.bytes = ctx.bytes;
    a.speed = speed;
    a.paused = ctx.ctl.paused;
    a.connections = ctx.limiter ? ctx.limiter.value : 0;
    a.doneSegs = ctx.doneSegs;
    a.totalSegs = ctx.totalSegs;
    if (ctx.live) {
      a.pct = -1;
      a.recorded = ctx.recorded;
      a.eta = 0;
    } else if (ctx.knownTotalBytes) {
      a.pct = Math.min(99, (ctx.bytes / ctx.knownTotalBytes) * 100);
      a.eta = speed > 0 ? (ctx.knownTotalBytes - ctx.bytes) / speed : 0;
    } else if (ctx.totalSegs > 0) {
      a.pct = Math.min(99, (ctx.doneSegs / ctx.totalSegs) * 100);
      const est = ctx.doneSegs > 0 ? (ctx.bytes / ctx.doneSegs) * ctx.totalSegs : 0;
      a.eta = speed > 0 && est ? Math.max(0, (est - ctx.bytes) / speed) : 0;
      a.estBytes = est;
    } else if (ctx.estimateSegs) {
      a.pct = Math.min(95, (ctx.doneSegs / ctx.estimateSegs) * 100);
      a.eta = 0;
    }
    emit();
  }

  function log(ctx, line) {
    const a = S.active;
    if (!a || !ctx || a.id !== ctx.job.id) return;
    a.log.push(line);
    if (a.log.length > LOG_CAP) a.log.shift();
  }

  function setPhase(ctx, phase, message) {
    const a = S.active;
    if (!a || a.id !== ctx.job.id) return;
    a.phase = phase;
    if (message != null) a.message = message;
    a.canPause = phase === 'downloading' || phase === 'recording';
    a.canStop = phase === 'resolving' || phase === 'downloading' || phase === 'recording';
    emit(true);
  }

  /* ---------------- segment downloading ---------------- */

  function mapKey(m) {
    return m.url + '|' + (m.byterange ? m.byterange.offset + '-' + m.byterange.length : '');
  }

  async function fetchMaps(ctx, segments) {
    const maps = new Map();
    for (const s of segments) if (s.map && !maps.has(mapKey(s.map))) maps.set(mapKey(s.map), s.map);
    for (const [k, m] of maps) {
      if (ctx.maps.has(k)) continue;
      const buf = await fetchRetry(ctx, m.url, m.byterange, { retries: Math.max(3, ctx.opts.retries) });
      ctx.maps.set(k, new Uint8Array(buf));
      addBytes(ctx, buf.byteLength);
    }
  }

  // Download a known list of segments with the shared limiter. Returns an
  // array of Blob|null in segment order.
  async function downloadList(ctx, segments, opts) {
    opts = opts || {};
    const results = new Array(segments.length).fill(null);
    const failed = [];
    let next = 0;
    const lim = ctx.limiter;

    async function one(i, retries) {
      const seg = segments[i];
      await lim.acquire();
      let kind = 'ok';
      try {
        let buf = await fetchRetry(ctx, seg.url, seg.byterange, { retries });
        if (seg.key) buf = await decrypt(ctx, seg, buf);
        results[i] = new Blob([buf]);
        addBytes(ctx, buf.byteLength);
        ctx.doneSegs++;
        updateProgress(ctx);
        return true;
      } catch (e) {
        if (e && e.cancelled) return false;
        kind = (e && (e.status === 429 || e.status === 503 || e.timeout)) ? 'throttle' : 'fail';
        return e;
      } finally {
        lim.release(kind);
        if (ctx.opts.delayMs > 0) await nap(ctx.opts.delayMs, ctx.ctl);
      }
    }

    async function worker() {
      while (!ctx.ctl.cancelled) {
        const i = next++;
        if (i >= segments.length) return;
        const r = await one(i, ctx.opts.retries);
        if (r !== true && r !== false) failed.push(i);
      }
    }

    const n = Math.min(lim.workers, segments.length);
    await Promise.all(Array.from({ length: n }, worker));

    // Second chance for failures, slowly and with extra patience.
    if (failed.length && !ctx.ctl.cancelled) {
      log(ctx, `Retrying ${failed.length} failed segment(s)…`);
      for (const i of failed.sort((a, b) => a - b)) {
        if (ctx.ctl.cancelled) break;
        await nap(500, ctx.ctl);
        await one(i, ctx.opts.retries + 2);
      }
    }
    return results;
  }

  // Turn per-segment results into ordered Blob parts (init segments inserted
  // wherever the map changes). Missing segments follow the onMissing policy;
  // a user stop always keeps the contiguous prefix.
  function assemble(ctx, segments, results) {
    const parts = [];
    let lastMap = null;
    let missing = 0;
    let count = 0;
    let duration = 0;
    let firstMissing = -1;
    for (let i = 0; i < segments.length; i++) {
      if (!results[i]) {
        if (firstMissing < 0) firstMissing = i;
        if (ctx.ctl.cancelled || ctx.opts.onMissing === 'stop') break;
        missing++;
        continue;
      }
      const seg = segments[i];
      if (seg.map) {
        const k = mapKey(seg.map);
        if (k !== lastMap && ctx.maps.has(k)) {
          parts.push(ctx.maps.get(k));
          lastMap = k;
        }
      }
      parts.push(results[i]);
      count++;
      duration += seg.duration || 0;
    }
    if (firstMissing >= 0 && !ctx.ctl.cancelled) {
      ctx.partial = true;
      if (ctx.opts.onMissing === 'stop') log(ctx, `Segment ${firstMissing + 1} is missing — stopped there as requested.`);
      else log(ctx, `${missing} segment(s) could not be downloaded and were skipped.`);
    }
    return { parts, count, duration };
  }

  async function downloadTrack(ctx, track) {
    await fetchMaps(ctx, track.segments);
    const results = await downloadList(ctx, track.segments);
    return assemble(ctx, track.segments, results);
  }

  /* ---------------- live HLS recording ---------------- */

  async function recordTrack(ctx, track) {
    const parts = [];
    let lastSeqDone = -Infinity;
    let lastMap = null;
    let duration = 0;
    let count = 0;
    let fails = 0;
    let playlist = track;
    const maxSec = ctx.opts.liveMaxSeconds || 0;
    const started = Date.now();

    for (;;) {
      const fresh = playlist.segments.filter((s) => s.seq > lastSeqDone);
      if (fresh.length) {
        ctx.totalSegs += fresh.length;
        await fetchMaps(ctx, fresh);
        const results = await downloadList(ctx, fresh);
        for (let i = 0; i < fresh.length; i++) {
          if (!results[i]) continue;
          const s = fresh[i];
          if (s.map && mapKey(s.map) !== lastMap && ctx.maps.has(mapKey(s.map))) {
            parts.push(ctx.maps.get(mapKey(s.map)));
            lastMap = mapKey(s.map);
          }
          parts.push(results[i]);
          duration += s.duration || 0;
          count++;
        }
        lastSeqDone = fresh[fresh.length - 1].seq;
        if (track.role !== 'audio') {
          ctx.recorded = duration;
          updateProgress(ctx);
        }
      }
      if (ctx.ctl.cancelled || !playlist.live) break;
      if (maxSec && (Date.now() - started) / 1000 >= maxSec) {
        log(ctx, 'Reached the recording time limit.');
        break;
      }
      await nap(Math.max(1000, (playlist.targetDuration || 6) * 500), ctx.ctl);
      if (ctx.ctl.cancelled) break;
      try {
        const r = await AVD_Manifest.load(track.playlistUrl, { credentials: ctx.credentials, timeout: ctx.opts.timeout });
        if (r.kind !== 'hls' || r.doc.kind !== 'media') throw new Error('playlist changed type');
        playlist = { ...r.doc, targetDuration: r.doc.targetDuration || track.targetDuration };
        fails = 0;
      } catch (e) {
        fails++;
        log(ctx, `Playlist refresh failed (${e.message || e}).`);
        if (fails >= 6) {
          log(ctx, 'Stream stopped responding — finishing the recording.');
          break;
        }
      }
    }
    return { parts, count, duration };
  }

  /* ---------------- seg-N templates (unknown length) ---------------- */

  async function downloadTemplate(ctx, t) {
    const build = (n) => t.pre + (t.pad > 0 ? String(n).padStart(t.pad, '0') : String(n)) + t.post;
    const range = ctx.opts.range || {};
    const start = range.from != null && isFinite(range.from) ? range.from : t.start;
    const hasEnd = range.to != null && isFinite(range.to);

    if (hasEnd) {
      // Explicit range: a plain known list.
      const segs = [];
      for (let n = start; n <= Math.min(range.to, start + TEMPLATE_CAP); n++) segs.push({ url: build(n), seq: n, duration: 0 });
      ctx.totalSegs = segs.length;
      log(ctx, `Fetching segments #${start}–#${range.to}.`);
      const results = await downloadList(ctx, segs);
      return assemble(ctx, segs, results);
    }

    ctx.estimateSegs = Math.max(Math.round((t.max || 0) * 1.15), 40);
    log(ctx, `Scanning from #${start} until the stream ends.`);
    const results = new Map();
    const holes = new Set();
    let failedAt = Infinity;
    let next = start;
    const lim = ctx.limiter;

    const fetchOne = async (n, retries, fatal) => {
      const buf = await fetchRetry(ctx, build(n), null, { retries, fatal });
      results.set(n, new Blob([buf]));
      addBytes(ctx, buf.byteLength);
      ctx.doneSegs++;
      updateProgress(ctx);
    };

    // A failure might be a one-off hole rather than the end: peek ahead.
    const isEnd = async (n) => {
      for (const k of [n + 1, n + 2]) {
        if (results.has(k)) return false;
        try {
          await fetchOne(k, 0, true);
          return false;
        } catch (e) {
          if (e && e.cancelled) return true;
        }
      }
      return true;
    };

    async function worker() {
      while (!ctx.ctl.cancelled) {
        const n = next++;
        if (n >= failedAt || n > start + TEMPLATE_CAP) return;
        if (results.has(n)) continue;
        await lim.acquire();
        let kind = 'ok';
        try {
          await fetchOne(n, ctx.opts.retries, true);
        } catch (e) {
          if (e && e.cancelled) return;
          kind = e && (e.status === 429 || e.status === 503 || e.timeout) ? 'throttle' : 'fail';
          if (await isEnd(n)) {
            if (n < failedAt) {
              failedAt = n;
              log(ctx, `Segment #${n} is unavailable → end of video.`);
            }
          } else {
            holes.add(n);
          }
        } finally {
          lim.release(kind);
          if (ctx.opts.delayMs > 0) await nap(ctx.opts.delayMs, ctx.ctl);
        }
      }
    }
    await Promise.all(Array.from({ length: lim.workers }, worker));

    for (const n of [...holes].sort((a, b) => a - b)) {
      if (ctx.ctl.cancelled || n >= failedAt) continue;
      try {
        await fetchOne(n, ctx.opts.retries + 2, false);
      } catch (e) {
        /* stays a hole */
      }
    }

    const last = failedAt === Infinity ? Math.max(start - 1, ...results.keys()) : failedAt - 1;
    const segs = [];
    const res = [];
    for (let n = start; n <= last; n++) {
      segs.push({ url: build(n), seq: n, duration: 0 });
      res.push(results.get(n) || null);
    }
    ctx.totalSegs = segs.length;
    return assemble(ctx, segs, res);
  }

  /* ---------------- direct files ---------------- */

  async function downloadFile(ctx, src) {
    const ctl = ctx.ctl;
    // Probe for range support with a 1-byte request.
    let total = 0;
    let ranged = false;
    let mime = src.mime || '';
    try {
      const ac = new AbortController();
      ctl.aborters.add(ac);
      const t = setTimeout(() => ac.abort(), 15000);
      const res = await fetch(src.url, { cache: 'no-store', credentials: ctx.credentials, headers: { Range: 'bytes=0-0' }, signal: ac.signal });
      clearTimeout(t);
      ctl.aborters.delete(ac);
      mime = res.headers.get('content-type') || mime;
      if (res.status === 206) {
        const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
        if (m) {
          total = parseInt(m[1], 10);
          ranged = true;
        }
      } else if (res.ok) {
        total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      } else {
        throw new HttpError(res.status);
      }
      try {
        if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
      } catch (e) {}
    } catch (e) {
      if (ctl.cancelled) throw new Cancelled();
      if (e instanceof HttpError) throw e;
      log(ctx, 'Range probe failed — falling back to a single stream.');
    }
    ctx.mime = mime;
    if (total) ctx.knownTotalBytes = total;

    if (ranged && total >= CHUNK_MIN_FILE) {
      const segs = [];
      for (let off = 0; off < total; off += CHUNK_SIZE) {
        segs.push({ url: src.url, seq: segs.length, duration: 0, byterange: { offset: off, length: Math.min(CHUNK_SIZE, total - off) } });
      }
      ctx.totalSegs = segs.length;
      log(ctx, `Server supports ranges — downloading ${segs.length} chunks in parallel.`);
      const results = await downloadList(ctx, segs);
      if (results.some((r) => !r) && !ctl.cancelled) throw new Error('some chunks could not be downloaded');
      const parts = [];
      for (const r of results) {
        if (!r) break;
        parts.push(r);
      }
      return { parts, count: parts.length, duration: 0 };
    }

    // Single stream, resuming with Range after drops when the server allows.
    log(ctx, 'Downloading as a single stream.');
    const parts = [];
    let received = 0;
    let attempt = 0;
    for (;;) {
      await whilePaused(ctl);
      if (ctl.cancelled) break;
      const ac = new AbortController();
      ctl.aborters.add(ac);
      try {
        const headers = received > 0 ? { Range: `bytes=${received}-` } : undefined;
        const res = await fetch(src.url, { cache: 'no-store', credentials: ctx.credentials, headers, signal: ac.signal });
        if (!res.ok) throw new HttpError(res.status);
        if (received > 0 && res.status !== 206) {
          // Server restarted from zero — discard what we had.
          parts.length = 0;
          ctx.bytes -= received;
          received = 0;
        }
        if (!total) total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
        if (total) ctx.knownTotalBytes = total;
        const reader = res.body.getReader();
        let stall = null;
        const arm = () => {
          clearTimeout(stall);
          stall = setTimeout(() => ac.abort(), (ctx.opts.timeout || 30) * 1000);
        };
        arm();
        for (;;) {
          if (ctl.cancelled) break;
          if (ctl.paused) {
            clearTimeout(stall);
            await whilePaused(ctl);
            arm();
          }
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          parts.push(value);
          received += value.length;
          addBytes(ctx, value.length);
          updateProgress(ctx);
        }
        clearTimeout(stall);
        if (ctl.cancelled) {
          try {
            reader.cancel();
          } catch (e) {}
        }
        break;
      } catch (e) {
        if (ctl.cancelled) break;
        if (e instanceof HttpError && FATAL.has(e.status)) throw e;
        attempt++;
        if (attempt > ctx.opts.retries) throw e;
        log(ctx, `Connection dropped at ${AVD.formatBytes(received)} — resuming (${attempt}/${ctx.opts.retries})…`);
        await nap(Math.min(8000, 500 * 2 ** attempt), ctl);
      } finally {
        ctl.aborters.delete(ac);
      }
    }
    if (!received) throw new Error('no data received');
    return { parts: [new Blob(parts)], count: 1, duration: 0 };
  }

  /* ---------------- containers ---------------- */

  async function sniff(blob) {
    const b = new Uint8Array(await blob.slice(0, 400).arrayBuffer());
    const at = (o, s) => String.fromCharCode(...b.slice(o, o + s.length)) === s;
    if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return 'ts';
    if (at(4, 'ftyp') || at(4, 'styp') || at(4, 'moof') || at(4, 'sidx') || at(4, 'moov')) return 'mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
    if (at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xf6) === 0xf0)) {
      // ID3 tags precede ADTS audio and also some TS packs; look for TS sync.
      for (let i = 0; i < b.length - 188; i++) if (b[i] === 0x47 && b[i + 188] === 0x47) return 'ts';
      return 'aac';
    }
    if (at(0, 'OggS')) return 'ogg';
    return '';
  }

  function extFromMime(mime, url) {
    const m = /\.(mp4|m4v|webm|mov|ogv|ts|mkv|m4a|mp3|aac)(?:[?#]|$)/i.exec(String(url || ''));
    if (m) return m[1].toLowerCase();
    const t = String(mime || '').split(';')[0].trim().toLowerCase();
    return (
      {
        'video/webm': 'webm',
        'video/quicktime': 'mov',
        'video/ogg': 'ogv',
        'video/mp2t': 'ts',
        'video/x-matroska': 'mkv',
        'audio/mp4': 'm4a',
        'audio/mpeg': 'mp3',
        'audio/aac': 'aac',
      }[t] || 'mp4'
    );
  }

  /* ---------------- ffmpeg.wasm (lazy-loaded) ---------------- */

  let ff = null;
  let ffLoading = null;
  let ffLog = [];
  let ffProgress = null;

  function ffUrl(file) {
    return new URL('vendor/ffmpeg/' + file, location.href).href;
  }

  function loadFFmpegScript() {
    if (globalThis.FFmpegWASM && globalThis.FFmpegWASM.FFmpeg) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ffUrl('ffmpeg.js'); // UMD build → globalThis.FFmpegWASM
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ffmpeg.js'));
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function getFFmpeg() {
    if (ff && ff.loaded) return ff;
    if (!ffLoading) {
      ffLoading = (async () => {
        await loadFFmpegScript();
        const inst = new globalThis.FFmpegWASM.FFmpeg();
        inst.on('log', ({ message }) => {
          ffLog.push(message);
          if (ffLog.length > 40) ffLog.shift();
        });
        inst.on('progress', ({ progress }) => {
          if (ffProgress && typeof progress === 'number' && progress >= 0 && progress <= 1) ffProgress(progress);
        });
        await inst.load({ coreURL: ffUrl('ffmpeg-core.js'), wasmURL: ffUrl('ffmpeg-core.wasm') });
        return inst;
      })();
    }
    try {
      ff = await ffLoading;
    } finally {
      ffLoading = null;
    }
    return ff;
  }

  function ffDispose() {
    try {
      if (ff) ff.terminate();
    } catch (e) {}
    ff = null;
  }

  async function ffRun(ctx, inputs, args, outName) {
    const inst = await getFFmpeg();
    ffLog = [];
    ffProgress = (p) => {
      if (S.active && S.active.id === ctx.job.id) {
        S.active.pct = Math.round(p * 100);
        emit();
      }
    };
    try {
      for (const inp of inputs) await inst.writeFile(inp.name, new Uint8Array(await inp.blob.arrayBuffer()));
      const code = await inst.exec(['-hide_banner', '-y', ...args, outName]);
      let out = null;
      try {
        out = await inst.readFile(outName);
      } catch (e) {}
      if (code !== 0 || !out || !out.length) {
        const tail = ffLog.filter((l) => /error|invalid|could not|not supported/i.test(l)).slice(-1)[0];
        throw new Error(tail || 'ffmpeg exited with code ' + code);
      }
      return new Blob([out]);
    } finally {
      ffProgress = null;
      for (const f of [...inputs.map((i) => i.name), outName]) {
        try {
          await inst.deleteFile(f);
        } catch (e) {}
      }
    }
  }

  const MIME = {
    mp4: 'video/mp4',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    ts: 'video/mp2t',
    aac: 'audio/aac',
  };

  // Each attempt is [ext, args]; the first that ffmpeg accepts wins.
  async function ffTry(ctx, inputs, attempts) {
    let lastErr = null;
    for (const [ext, args] of attempts) {
      try {
        return { blob: await ffRun(ctx, inputs, args, 'out.' + ext), ext };
      } catch (e) {
        lastErr = e;
        log(ctx, `ffmpeg → .${ext} failed: ${e.message || e}`);
      }
    }
    throw lastErr || new Error('conversion failed');
  }

  /* ---------------- output ---------------- */

  const objectUrls = [];
  async function save(ctx, blob, ext) {
    const folder = AVD.sanitizeFolder(ctx.opts.subfolder);
    const name = (folder ? folder + '/' : '') + ctx.baseName + '.' + ext;
    const url = URL.createObjectURL(new Blob([blob], { type: MIME[ext] || 'application/octet-stream' }));
    objectUrls.push(url);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }, 10 * 60 * 1000);
    let r = { ok: false };
    try {
      r = (AVD_Engine.onSave && (await AVD_Engine.onSave(url, name, !!ctx.opts.saveAs))) || { ok: false };
    } catch (e) {
      r = { ok: false, error: String(e && e.message) };
    }
    const file = { name: ctx.baseName + '.' + ext, id: r.id != null ? r.id : null, size: blob.size, ok: !!r.ok };
    ctx.files.push(file);
    if (!r.ok) log(ctx, `Saving ${file.name} failed${r.error ? ': ' + r.error : ''} — check the browser’s download settings.`);
    else log(ctx, `Saved ${file.name} (${AVD.formatBytes(blob.size)}).`);
    return file;
  }

  async function produce(ctx, outputs) {
    const fmt = ctx.opts.format || 'auto';
    const video = outputs.find((o) => o.role !== 'audio');
    const audio = outputs.find((o) => o.role === 'audio');
    const totalSize = outputs.reduce((n, o) => n + o.blob.size, 0);
    const canFF = totalSize < FFMPEG_LIMIT;
    if (!canFF) log(ctx, `File is ${AVD.formatBytes(totalSize)} — too large to convert in the browser, saving as-is.`);

    const saveRaw = async () => {
      for (const o of outputs) {
        const prev = ctx.baseName;
        if (outputs.length > 1) ctx.baseName = prev + (o.role === 'audio' ? ' (audio)' : ' (video)');
        await save(ctx, o.blob, o.ext);
        ctx.baseName = prev;
      }
    };

    setPhase(ctx, 'processing', 'Preparing your file…');
    S.active.pct = 0;

    const mp4Copy = ['-map', '0:v?', '-map', '0:a?', '-dn', '-sn', '-c', 'copy', '-movflags', '+faststart'];

    try {
      if (fmt === 'audio') {
        const src = audio || video;
        if (!canFF) return saveRaw();
        const inputs = [{ name: 'in.' + src.ext, blob: src.blob }];
        const r = await ffTry(ctx, inputs, [
          ['m4a', ['-i', inputs[0].name, '-map', '0:a:0', '-vn', '-c:a', 'copy', '-movflags', '+faststart']],
          ['mp3', ['-i', inputs[0].name, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2']],
        ]);
        ctx.outFormat = r.ext;
        await save(ctx, r.blob, r.ext);
        return;
      }

      if (video && audio) {
        if (!canFF) return saveRaw();
        const inputs = [
          { name: 'v.' + video.ext, blob: video.blob },
          { name: 'a.' + audio.ext, blob: audio.blob },
        ];
        const muxArgs = ['-i', inputs[0].name, '-i', inputs[1].name, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy'];
        const webm = video.ext === 'webm' && audio.ext === 'webm';
        const attempts = webm && fmt !== 'mp4' ? [['webm', muxArgs], ['mkv', muxArgs]] : [['mp4', [...muxArgs, '-movflags', '+faststart']], ['mkv', muxArgs]];
        try {
          const r = await ffTry(ctx, inputs, attempts);
          ctx.outFormat = r.ext;
          await save(ctx, r.blob, r.ext);
        } catch (e) {
          log(ctx, 'Could not merge audio and video — saving them as two files.');
          ctx.partial = true;
          await saveRaw();
        }
        if (ctx.opts.keepOriginal) await saveRaw();
        return;
      }

      const src = video || audio;
      const wantRemux =
        canFF &&
        (fmt === 'mp4' || (fmt === 'auto' && ctx.job.source.type !== 'file' && (src.ext === 'ts' || src.ext === 'mp4')));
      if (fmt === 'original' || !wantRemux) {
        ctx.outFormat = src.ext;
        await save(ctx, src.blob, src.ext);
        return;
      }
      const inputs = [{ name: 'in.' + src.ext, blob: src.blob }];
      try {
        const r = await ffTry(ctx, inputs, [['mp4', ['-i', inputs[0].name, ...mp4Copy]]]);
        ctx.outFormat = 'mp4';
        await save(ctx, r.blob, 'mp4');
        if (ctx.opts.keepOriginal && src.ext !== 'mp4') await save(ctx, src.blob, src.ext);
      } catch (e) {
        log(ctx, `MP4 conversion failed — saving the original .${src.ext} instead.`);
        ctx.outFormat = src.ext;
        await save(ctx, src.blob, src.ext);
      }
    } finally {
      ffDispose();
    }
  }

  /* ---------------- job lifecycle ---------------- */

  function friendlyError(e) {
    const st = e && e.status;
    if (st === 401 || st === 403) return `Access denied (HTTP ${st}) — the link may have expired. Reload the page, play the video, then try again.`;
    if (st === 404 || st === 410) return `Not found (HTTP ${st}) — the link expired or moved. Reload the page and try again.`;
    if (st === 429) return 'The server is rate-limiting (HTTP 429). Try Manual mode with fewer parallel requests or a delay.';
    if (st >= 500) return `The server had a problem (HTTP ${st}). Try again in a moment.`;
    if (e && e.timeout) return 'The server stopped responding (timed out). Try again, or raise the timeout in Manual mode.';
    const msg = (e && e.message) || String(e);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'Network error — you may be offline, or the site blocks downloads from extensions.';
    return msg;
  }

  function normaliseOpts(o) {
    const d = AVD.DEFAULT_SETTINGS;
    o = o || {};
    return {
      format: o.format || d.format,
      keepOriginal: !!o.keepOriginal,
      concurrency: Math.max(0, Math.min(64, parseInt(o.concurrency, 10) || 0)),
      retries: Math.max(0, Math.min(10, o.retries != null ? parseInt(o.retries, 10) : d.retries)),
      timeout: Math.max(5, Math.min(180, parseInt(o.timeout, 10) || d.timeout)),
      delayMs: Math.max(0, Math.min(5000, parseInt(o.delayMs, 10) || 0)),
      onMissing: o.onMissing === 'stop' ? 'stop' : 'skip',
      range: o.range || null,
      live: o.live !== false,
      liveMaxSeconds: Math.max(0, parseInt(o.liveMaxSeconds, 10) || 0),
      referer: o.referer || '',
      sendCookies: o.sendCookies !== false,
      subfolder: o.subfolder || '',
      saveAs: !!o.saveAs,
    };
  }

  function freshActive(job) {
    return {
      id: job.id,
      title: job.title,
      site: job.site,
      thumb: job.thumb || '',
      pageUrl: job.pageUrl || '',
      sourceType: job.source.type,
      quality: job.qualityHint || '',
      phase: 'resolving',
      message: 'Getting ready…',
      paused: false,
      canPause: false,
      canStop: true,
      pct: 0,
      bytes: 0,
      estBytes: 0,
      speed: 0,
      eta: 0,
      connections: 0,
      doneSegs: 0,
      totalSegs: 0,
      recorded: 0,
      live: false,
      files: [],
      log: [],
      startedAt: Date.now(),
    };
  }

  async function runJob(job) {
    const opts = normaliseOpts(job.options);
    const ctl = { cancelled: false, discard: false, paused: false, aborters: new Set() };
    const ctx = {
      job,
      opts,
      ctl,
      credentials: opts.sendCookies ? 'include' : 'omit',
      limiter: makeLimiter(ctl, opts.concurrency),
      keys: new Map(),
      maps: new Map(),
      bytes: 0,
      samples: [],
      doneSegs: 0,
      totalSegs: 0,
      estimateSegs: 0,
      knownTotalBytes: 0,
      recorded: 0,
      live: false,
      partial: false,
      files: [],
      baseName: AVD.sanitizeFilename(job.filename || job.title, 'video'),
      outFormat: '',
      quality: job.qualityHint || '',
      duration: 0,
      segments: 0,
    };
    cur = ctx;
    S.active = freshActive(job);
    emit(true);

    let status = 'complete';
    let error = '';
    try {
      if (AVD_Engine.onHeaders && opts.referer) {
        try {
          await AVD_Engine.onHeaders({ referer: opts.referer });
        } catch (e) {}
      }
      const outputs = await acquire(ctx);
      if (ctl.discard) {
        status = 'canceled';
      } else if (!outputs.length || outputs.every((o) => !o.blob.size)) {
        if (ctl.cancelled) status = 'canceled';
        else throw new Error('Nothing could be downloaded. The link may have expired — reload the page and try again.');
      } else {
        await produce(ctx, outputs);
        if ((ctl.cancelled && !ctx.live) || ctx.partial) status = 'partial';
        if (!ctx.files.some((f) => f.ok)) {
          status = 'failed';
          error = 'The browser refused to save the file.';
        }
      }
    } catch (e) {
      if (e && e.cancelled) status = 'canceled';
      else {
        status = 'failed';
        error = friendlyError(e);
        log(ctx, 'Error: ' + ((e && e.message) || e));
      }
    } finally {
      if (AVD_Engine.onHeaders && opts.referer) {
        try {
          await AVD_Engine.onHeaders(null);
        } catch (e) {}
      }
      ffDispose();
    }
    finish(ctx, status, error);
  }

  // Resolve the source and download every track → [{ role, blob, ext }].
  async function acquire(ctx) {
    const { job, opts } = ctx;
    const src = job.source;
    const outputs = [];

    if (src.type === 'file') {
      setPhase(ctx, 'downloading', 'Downloading…');
      const r = await downloadFile(ctx, src);
      const blob = new Blob(r.parts);
      const sn = await sniff(blob);
      const urlExt = extFromMime(ctx.mime, src.url);
      const ext = sn === 'mp4' && /^(mov|m4v|m4a)$/.test(urlExt) ? urlExt : sn || urlExt;
      outputs.push({ role: 'muxed', blob, ext });
      ctx.segments = 1;
      return outputs;
    }

    if (src.type === 'template') {
      setPhase(ctx, 'downloading', 'Downloading segments…');
      const r = await downloadTemplate(ctx, src);
      if (!r.parts.length) return outputs;
      const blob = new Blob(r.parts);
      outputs.push({ role: 'muxed', blob, ext: (await sniff(blob)) || src.ext || 'ts' });
      ctx.segments = r.count;
      return outputs;
    }

    // HLS / DASH manifests
    setPhase(ctx, 'resolving', 'Reading the stream…');
    const res = await AVD_Manifest.resolve(
      src.url,
      { variant: src.variant || null, audio: src.audio || null, audioOnly: opts.format === 'audio' },
      { credentials: ctx.credentials, timeout: opts.timeout }
    );
    if (ctx.ctl.cancelled) throw new Cancelled();
    if (res.quality) {
      ctx.quality = res.quality;
      S.active.quality = res.quality;
    }
    const roles = res.tracks.map((t) => t.role).join(' + ');
    log(ctx, `Resolved ${src.type.toUpperCase()} stream: ${res.tracks.length} track(s) (${roles})${res.quality ? ', ' + res.quality : ''}.`);

    if (res.live && opts.live) {
      ctx.live = true;
      S.active.live = true;
      setPhase(ctx, 'recording', 'Recording live stream…');
      log(ctx, 'Live stream — recording until you press Stop' + (opts.liveMaxSeconds ? ` or ${AVD.formatDuration(opts.liveMaxSeconds)} elapse.` : '.'));
      const recs = await Promise.all(res.tracks.map((t) => recordTrack(ctx, t)));
      for (let i = 0; i < recs.length; i++) {
        if (!recs[i].parts.length) continue;
        const blob = new Blob(recs[i].parts);
        outputs.push({ role: res.tracks[i].role, blob, ext: (await sniff(blob)) || 'ts' });
      }
      ctx.duration = recs[0] ? recs[0].duration : 0;
      ctx.segments = recs.reduce((n, r) => n + r.count, 0);
      return outputs;
    }

    const range = opts.range || {};
    const tracks = res.tracks.map((t) => ({ ...t, segments: AVD_Manifest.sliceByTime(t.segments, range.from, range.to) }));
    if (range.from || range.to) log(ctx, `Trimming to ${AVD.formatDuration(range.from || 0) || '0:00'} – ${range.to ? AVD.formatDuration(range.to) : 'end'}.`);
    ctx.totalSegs = tracks.reduce((n, t) => n + t.segments.length, 0);
    if (!ctx.totalSegs) throw new Error('The selected range contains no segments.');
    const enc = tracks.some((t) => t.segments.some((s) => s.key));
    log(ctx, `Downloading ${ctx.totalSegs} segments${enc ? ' (AES-128 encrypted — decrypting on the fly)' : ''}.`);
    setPhase(ctx, 'downloading', 'Downloading…');

    const done = await Promise.all(tracks.map((t) => downloadTrack(ctx, t)));
    for (let i = 0; i < done.length; i++) {
      if (!done[i].parts.length) continue;
      const blob = new Blob(done[i].parts);
      const sn = await sniff(blob);
      outputs.push({ role: tracks[i].role, blob, ext: sn || ((tracks[i].mime || '').includes('webm') ? 'webm' : 'ts') });
      if (i === 0) ctx.duration = done[i].duration;
      ctx.segments += done[i].count;
    }
    return outputs;
  }

  function finish(ctx, status, error) {
    const a = S.active;
    const job = ctx.job;
    const size = ctx.files.reduce((n, f) => n + (f.ok ? f.size : 0), 0);
    const elapsed = (Date.now() - (a ? a.startedAt : Date.now())) / 1000;
    if (a && a.id === job.id) {
      a.phase = status === 'complete' ? 'done' : status === 'partial' ? 'done' : status === 'canceled' ? 'canceled' : 'error';
      a.status = status;
      a.pct = status === 'failed' || status === 'canceled' ? a.pct : 100;
      a.canPause = false;
      a.canStop = false;
      a.paused = false;
      a.speed = 0;
      a.eta = 0;
      a.files = ctx.files;
      a.discarded = ctx.ctl.discard;
      a.message =
        status === 'complete'
          ? ctx.live
            ? 'Recording saved'
            : 'Saved to Downloads'
          : status === 'partial'
          ? 'Saved (partial)'
          : status === 'canceled'
          ? 'Stopped before anything was saved'
          : error || 'Download failed';
      S.recent.unshift({ ...a, log: [] });
      S.recent = S.recent.slice(0, RECENT_CAP);
    }
    cur = null;
    emit(true);

    if (status !== 'canceled' && AVD_Engine.onFinished) {
      try {
        AVD_Engine.onFinished({
          id: job.id,
          title: job.title,
          site: job.site,
          pageUrl: job.pageUrl || '',
          favicon: job.favicon || '',
          thumb: job.thumb || '',
          sourceType: job.source.type,
          sourceUrl: job.source.url || (job.source.pre ? job.source.pre + '#' + String(job.source.post || '').split('?')[0] : ''),
          quality: ctx.quality || '',
          format: ctx.outFormat || '',
          files: ctx.files,
          size,
          duration: ctx.duration || ctx.recorded || 0,
          segments: ctx.segments,
          status,
          error: error || '',
          mode: job.mode || 'auto',
          live: ctx.live,
          startedAt: a ? a.startedAt : Date.now(),
          finishedAt: Date.now(),
          elapsed,
        });
      } catch (e) {}
    }
    setTimeout(pumpQueue, 50);
  }

  let pumping = false;
  async function pumpQueue() {
    if (pumping || cur) return;
    pumping = true;
    try {
      while (!cur && queue.length) {
        const job = queue.shift();
        await runJob(job);
      }
    } finally {
      pumping = false;
    }
  }

  function control(action, id) {
    const ctx = cur;
    if (action === 'dequeue') {
      queue = queue.filter((j) => j.id !== id);
      emit(true);
      return;
    }
    if (action === 'dismiss') {
      S.recent = S.recent.filter((r) => r.id !== id);
      if (S.active && S.active.id === id && !cur) S.active = null;
      emit(true);
      return;
    }
    if (!ctx || (id && ctx.job.id !== id)) return;
    if (action === 'pause') {
      ctx.ctl.paused = true;
      log(ctx, 'Paused.');
      updateProgress(ctx);
      emit(true);
    } else if (action === 'resume') {
      ctx.ctl.paused = false;
      log(ctx, 'Resumed.');
      ctx.limiter.pump();
      emit(true);
    } else if (action === 'stop' || action === 'cancel') {
      ctx.ctl.cancelled = true;
      ctx.ctl.paused = false;
      if (action === 'cancel') ctx.ctl.discard = true;
      for (const ac of ctx.ctl.aborters) {
        try {
          ac.abort();
        } catch (e) {}
      }
      ctx.limiter.flush();
      log(ctx, action === 'cancel' ? 'Canceling…' : ctx.live ? 'Stopping the recording…' : 'Stopping — saving what we have.');
      if (S.active) S.active.message = action === 'cancel' ? 'Canceling…' : 'Finishing up…';
      emit(true);
    }
  }

  async function handleCommand(cmd) {
    if (!cmd || typeof cmd.seq !== 'number' || cmd.seq <= lastSeq) return;
    lastSeq = cmd.seq;
    if (cmd.action === 'enqueue' && cmd.job) {
      queue.push(cmd.job);
      emit(true);
      pumpQueue();
    } else if (cmd.action === 'sync') {
      emit(true);
    } else {
      control(cmd.action, cmd.id);
    }
  }

  // Heartbeat so the popup can tell a live job from one whose host died.
  setInterval(() => {
    if (cur) emit();
  }, 4000);

  const AVD_Engine = {
    onState: null,
    onSave: null,
    onHeaders: null,
    onFinished: null,
    handleCommand,
  };
  globalThis.AVD_Engine = AVD_Engine;
})();
