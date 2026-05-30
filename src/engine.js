// Adaptive Video Downloader — download engine.
//
// Runs in a PERSISTENT context so a download keeps going (and still saves)
// after the toolbar popup closes:
//   • Chrome (MV3): inside an offscreen document (offscreen.html + offscreen.js).
//   • Firefox (MV2): inside the persistent background page (loaded alongside
//     background.js via the manifest "background.scripts" list).
//
// The engine itself touches no chrome.* APIs — offscreen documents only get
// chrome.runtime, so anything privileged (publishing progress, saving the file)
// goes through two callbacks the host wires up:
//   AVD_Engine.onState(state)         → publish progress for the popup to render
//   AVD_Engine.onSave(url, filename)  → hand the finished blob to Downloads
// The host drives it by calling AVD_Engine.handleCommand({ seq, action, job }).

(function () {
  const SEG_RE = /seg-(\d+)/;
  const MAX_SEG = 3000; // hard ceiling per the spec
  const DEFAULT_CONCURRENCY = 6;
  const RETRIES = 2; // extra attempts after the first → 3 tries total
  const LOG_CAP = 60;

  // ---- per-job state ----
  let job = null;
  let template = null;
  let concurrency = DEFAULT_CONCURRENCY;
  let cancelled = false;
  let nextN = 1;
  let failedAt = Infinity;
  let data = []; // data[n] = Uint8Array
  let fetchedCount = 0;
  let highestTried = 0;
  let finalParts = null; // merged TS segments, kept for optional MP4 conversion
  let baseName = 'video';
  const objectUrls = [];
  let lastSeq = 0;
  let running = false;

  // ---- published state (small, structured-cloneable — no media bytes) ----
  function freshState() {
    return {
      id: null,
      phase: 'idle', // starting | running | done | stopped | error | idle
      kind: null,
      title: '',
      label: '',
      stat: '',
      pct: 0,
      done: false, // green (finished) bar
      canStop: false,
      saved: false,
      saveName: '',
      convert: { available: false, state: 'idle', status: '', name: '' },
      log: [],
      note: '',
      ts: Date.now(),
    };
  }
  let S = freshState();

  function log(line) {
    S.log.push(line);
    if (S.log.length > LOG_CAP) S.log.shift();
  }

  // Throttle progress publishing so we don't flood the channel mid-download.
  let emitTimer = null;
  let emitPending = false;
  function emit(immediate) {
    S.ts = Date.now();
    const send = () => {
      const cb = AVD_Engine.onState;
      if (cb) {
        try {
          cb(JSON.parse(JSON.stringify(S)));
        } catch (e) {
          /* host channel not ready */
        }
      }
    };
    if (immediate) {
      if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
      emitPending = false;
      send();
      return;
    }
    emitPending = true;
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      if (!emitPending) return;
      emitPending = false;
      send();
    }, 250);
  }

  function sanitize(name) {
    return (
      (name || 'video')
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'video'
    );
  }
  function buildSegUrl(n) {
    return template.replace(SEG_RE, 'seg-' + n);
  }

  async function save(blob, filename) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const cb = AVD_Engine.onSave;
    if (!cb) return false;
    try {
      return (await cb(url, filename)) !== false;
    } catch (e) {
      return false;
    }
  }

  /* ---------- HLS segment streams ---------- */

  async function fetchSeg(n) {
    const url = buildSegUrl(n);
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (cancelled) return null;
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 0) return buf;
        }
      } catch (e) {
        /* network error → retry */
      }
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return null;
  }

  async function worker() {
    while (true) {
      if (cancelled) return;
      const n = nextN++;
      if (n > MAX_SEG) return;
      if (n >= failedAt) return; // a lower segment already marked the end
      if (n > highestTried) highestTried = n;

      const buf = await fetchSeg(n);
      if (cancelled) return;

      if (buf === null) {
        failedAt = Math.min(failedAt, n);
        log(`seg-${n}: no response after ${RETRIES + 1} attempts → treating as end of video.`);
      } else {
        data[n] = new Uint8Array(buf);
        fetchedCount++;
        S.stat = `${fetchedCount} segment(s) downloaded · scanning seg-${highestTried}`;
        const estimate = Math.max((job.max || 0) * 1.5, 60);
        S.pct = Math.min(96, Math.round((highestTried / estimate) * 100));
        emit();
      }
    }
  }

  async function runHls() {
    template = job.template;
    concurrency = Math.max(1, Math.min(64, job.concurrency || DEFAULT_CONCURRENCY));

    S.title = 'Downloading video…';
    S.label = job.label || 'video';
    S.canStop = true;
    log('Source template: ' + template.replace(SEG_RE, 'seg-#'));
    log(`Fetching seg-1 … seg-${MAX_SEG} (stops at the first that fails ${RETRIES + 1} times).`);
    log(`Up to ${concurrency} segments at once${job.speed ? ' (' + job.speed + ' mode)' : ''}.`);
    emit(true);

    const startTime = Date.now();
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);
    await finalizeHls(startTime);
  }

  async function finalizeHls(startTime) {
    // Contiguous run from seg-1 guarantees a playable, gap-free file.
    const parts = [];
    let n = 1;
    while (n <= MAX_SEG && data[n]) {
      parts.push(data[n]);
      n++;
    }

    S.canStop = false;

    if (parts.length === 0) {
      S.phase = 'error';
      S.title = 'No segments could be downloaded';
      S.pct = 0;
      S.stat =
        'The first segment did not respond. The link token may have expired — reload the video page and try again.';
      emit(true);
      return;
    }

    baseName = sanitize(job.label);
    finalParts = parts;

    const blob = new Blob(parts, { type: 'video/mp2t' });
    const fname = baseName + '.ts';
    const ok = await save(blob, fname);

    const secs = ((Date.now() - startTime) / 1000).toFixed(0);
    const mb = (blob.size / 1048576).toFixed(1);
    S.pct = 100;
    S.done = true;
    S.phase = cancelled ? 'stopped' : 'done';
    S.title = cancelled ? 'Stopped — partial video saved' : 'Done! Video saved to Downloads';
    S.stat = `${parts.length} segments · ${mb} MB · ${secs}s → ${fname}`;
    S.saved = ok;
    S.saveName = fname;
    S.convert.available = true;
    log(`Merged ${parts.length} segments into ${fname} (${mb} MB).`);
    if (!ok) log('Auto-save to Downloads failed — check the browser’s download settings.');
    emit(true);
  }

  /* ---------- direct progressive files (TikTok, Instagram, …) ---------- */

  function fileExtFor(url, mime) {
    const path = url.split('?')[0].split('#')[0];
    const m = /\.(mp4|m4v|webm|mov|ogv|ts)$/i.exec(path);
    if (m) return '.' + m[1].toLowerCase();
    const t = (mime || '').split(';')[0].trim().toLowerCase();
    if (t === 'video/webm') return '.webm';
    if (t === 'video/quicktime') return '.mov';
    if (t === 'video/ogg') return '.ogv';
    return '.mp4';
  }

  async function runFile() {
    baseName = sanitize(job.label || 'video');
    S.title = 'Downloading file…';
    S.label = job.url.split('?')[0];
    S.canStop = true;
    log('Direct download: ' + job.url.split('?')[0]);
    emit(true);
    const startTime = Date.now();

    try {
      const res = await fetch(job.url, { cache: 'no-store' });
      if (!res.ok) throw new Error('server returned HTTP ' + res.status);

      const total = parseInt(res.headers.get('content-length') || '0', 10);
      const chunks = [];
      let received = 0;
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (reader) {
        for (;;) {
          if (cancelled) break;
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total) S.pct = Math.min(99, Math.round((received / total) * 100));
          S.stat =
            `${(received / 1048576).toFixed(1)} MB` + (total ? ` / ${(total / 1048576).toFixed(1)} MB` : '');
          emit();
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        chunks.push(buf);
        received = buf.length;
      }

      if (received === 0) throw new Error('no data received');

      const mime = res.headers.get('content-type') || job.mime || '';
      const fname = baseName + fileExtFor(job.url, mime);
      const blob = new Blob(chunks, { type: mime || 'application/octet-stream' });
      const ok = await save(blob, fname);

      S.canStop = false;
      S.pct = 100;
      S.done = true;
      S.phase = cancelled ? 'stopped' : 'done';
      const mb = (blob.size / 1048576).toFixed(1);
      const secs = ((Date.now() - startTime) / 1000).toFixed(0);
      S.title = cancelled ? 'Stopped — partial file saved' : 'Done! File saved to Downloads';
      S.stat = `${mb} MB · ${secs}s → ${fname}`;
      S.saved = ok;
      S.saveName = fname;
      if (!ok) log('Auto-save to Downloads failed — check the browser’s download settings.');
      emit(true);
    } catch (e) {
      S.canStop = false;
      S.phase = 'error';
      S.title = 'Download failed';
      S.stat =
        (e && e.message ? e.message : String(e)) + ' — the link may require the original page or have expired.';
      emit(true);
    }
  }

  /* ---------- optional lossless MP4 conversion (mux.js, lazy-loaded) ---------- */

  let muxLoading = null;
  function loadMuxjs() {
    if (typeof muxjs !== 'undefined' && muxjs.Transmuxer) return Promise.resolve();
    if (muxLoading) return muxLoading;
    muxLoading = new Promise((resolve, reject) => {
      const doc = typeof document !== 'undefined' ? document : null;
      if (!doc) {
        reject(new Error('no DOM available to load the converter'));
        return;
      }
      const s = doc.createElement('script');
      s.src = 'vendor/mux-mp4.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load the MP4 converter'));
      (doc.head || doc.documentElement).appendChild(s);
    });
    return muxLoading;
  }

  // --- minimal fMP4 box reader, used only to report the output duration ---
  function avdU32(b, o) {
    return b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3];
  }
  function avdReadBoxes(buf, start, end, cb) {
    let o = start;
    while (o + 8 <= end) {
      let size = avdU32(buf, o);
      let header = 8;
      const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      if (size === 1) {
        size = avdU32(buf, o + 8) * 4294967296 + avdU32(buf, o + 12);
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header || o + size > end) break;
      cb(type, o + header, o + size);
      o += size;
    }
  }
  function avdVideoTrack(init) {
    let chosen = null;
    let first = null;
    avdReadBoxes(init, 0, init.length, (t, ps, pe) => {
      if (t !== 'moov') return;
      avdReadBoxes(init, ps, pe, (t1, cs, ce) => {
        if (t1 !== 'trak') return;
        const tr = { id: 0, timescale: 0, vid: false };
        avdReadBoxes(init, cs, ce, (t2, cs2, ce2) => {
          if (t2 === 'tkhd') tr.id = init[cs2] === 1 ? avdU32(init, cs2 + 20) : avdU32(init, cs2 + 12);
          else if (t2 === 'mdia')
            avdReadBoxes(init, cs2, ce2, (t3, cs3) => {
              if (t3 === 'mdhd') tr.timescale = init[cs3] === 1 ? avdU32(init, cs3 + 20) : avdU32(init, cs3 + 12);
              else if (t3 === 'hdlr') {
                const h = String.fromCharCode(init[cs3 + 8], init[cs3 + 9], init[cs3 + 10], init[cs3 + 11]);
                if (h === 'vide') tr.vid = true;
              }
            });
        });
        if (!first) first = tr;
        if (tr.vid && !chosen) chosen = tr;
      });
    });
    return chosen || first;
  }
  function avdSumTrun(frag, trackId) {
    let sum = 0;
    avdReadBoxes(frag, 0, frag.length, (t, ps, pe) => {
      if (t !== 'moof') return;
      avdReadBoxes(frag, ps, pe, (t1, cs, ce) => {
        if (t1 !== 'traf') return;
        let id = 0;
        let defDur = 0;
        let hasDef = false;
        let fragSum = 0;
        avdReadBoxes(frag, cs, ce, (t2, cs2) => {
          if (t2 === 'tfhd') {
            const f = avdU32(frag, cs2) & 0xffffff;
            id = avdU32(frag, cs2 + 4);
            let off = cs2 + 8;
            if (f & 0x01) off += 8;
            if (f & 0x02) off += 4;
            if (f & 0x08) { defDur = avdU32(frag, off); hasDef = true; }
          } else if (t2 === 'trun') {
            const f = avdU32(frag, cs2) & 0xffffff;
            const c = avdU32(frag, cs2 + 4);
            let off = cs2 + 8;
            if (f & 0x01) off += 4;
            if (f & 0x04) off += 4;
            for (let i = 0; i < c; i++) {
              if (f & 0x100) { fragSum += avdU32(frag, off); off += 4; }
              else if (hasDef) { fragSum += defDur; }
              if (f & 0x200) off += 4;
              if (f & 0x400) off += 4;
              if (f & 0x800) off += 4;
            }
          }
        });
        if (id === trackId) sum += fragSum;
      });
    });
    return sum;
  }
  function mp4DurationSeconds(chunks) {
    try {
      if (!chunks || chunks.length < 2) return null;
      const track = avdVideoTrack(chunks[0]);
      if (!track || !track.timescale) return null;
      let total = 0;
      for (let i = 1; i < chunks.length; i++) total += avdSumTrun(chunks[i], track.id);
      return total ? total / track.timescale : null;
    } catch (e) {
      return null;
    }
  }
  function formatTime(totalSecs) {
    const s = Math.round(totalSecs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  }

  async function convert() {
    if (!finalParts || finalParts.length === 0) {
      S.convert.state = 'error';
      S.convert.status = 'Nothing to convert — re-download the video first.';
      emit(true);
      return;
    }
    if (S.convert.state === 'running' || S.convert.state === 'done') return;

    S.convert.state = 'running';
    S.convert.status = 'Loading converter…';
    emit(true);

    try {
      await loadMuxjs();
    } catch (e) {
      S.convert.state = 'error';
      S.convert.status = 'MP4 converter did not load.';
      emit(true);
      return;
    }
    if (typeof muxjs === 'undefined' || !muxjs.Transmuxer) {
      S.convert.state = 'error';
      S.convert.status = 'MP4 converter did not load.';
      emit(true);
      return;
    }

    const transmuxer = new muxjs.Transmuxer({ remux: true });
    const out = [];
    let init = null;
    let sawData = false;
    transmuxer.on('data', (seg) => {
      sawData = true;
      if (init === null) {
        init = seg.initSegment; // moov + track definitions (once)
        out.push(init);
      }
      out.push(seg.data); // moof + mdat fragments
    });

    try {
      // Flush after EACH segment. mux.js must process one segment per flush
      // cycle; pushing them all and flushing once makes it compute a frame
      // duration across a segment boundary where the decode timestamp jumps
      // backwards, which gets encoded as an unsigned 32-bit value (~13h) and
      // inflates the total duration. Per-segment flushing keeps timing correct.
      for (let i = 0; i < finalParts.length; i++) {
        transmuxer.push(finalParts[i]);
        transmuxer.flush();
        if (i % 20 === 0) {
          S.convert.status = `Remuxing to MP4… ${i + 1}/${finalParts.length} segments`;
          emit();
          await new Promise((r) => setTimeout(r)); // yield
        }
      }
    } catch (e) {
      S.convert.state = 'error';
      S.convert.status = 'Conversion failed: ' + (e && e.message ? e.message : e);
      emit(true);
      return;
    }

    if (!sawData || out.length === 0) {
      S.convert.state = 'error';
      S.convert.status =
        'Could not convert — the stream likely uses a codec other than H.264/AAC. Your .ts file is still saved.';
      emit(true);
      return;
    }

    const blob = new Blob(out, { type: 'video/mp4' });
    const fname = baseName + '.mp4';
    const ok = await save(blob, fname);

    const mb = (blob.size / 1048576).toFixed(1);
    const durSecs = mp4DurationSeconds(out);
    const durStr = durSecs ? ` · ${formatTime(durSecs)}` : '';
    S.convert.state = 'done';
    S.convert.name = fname;
    S.convert.status = `MP4 saved (${mb} MB${durStr}) → ${fname}` + (ok ? '' : ' (auto-save failed)');
    log(`Converted to ${fname} (${mb} MB${durStr}).`);
    emit(true);
  }

  /* ---------- command handling ---------- */

  function resetForJob(j) {
    cancelled = false;
    nextN = 1;
    failedAt = Infinity;
    data = [];
    fetchedCount = 0;
    highestTried = 0;
    finalParts = null;
    baseName = 'video';
    objectUrls.splice(0).forEach((u) => {
      try { URL.revokeObjectURL(u); } catch (e) {}
    });
    S = freshState();
    S.id = j.id;
    S.kind = j.kind;
    S.phase = 'starting';
    S.note = 'You can close this popup — the download keeps running in the background.';
  }

  async function startJob(j) {
    job = j;
    resetForJob(j);
    emit(true);
    running = true;
    S.phase = 'running';
    try {
      if (j.kind === 'file') await runFile();
      else await runHls();
    } finally {
      running = false;
    }
  }

  // Driven by the host. Commands are de-duplicated by a monotonic seq so an
  // offscreen document created in response to a command (and that then also
  // receives it live) only acts once.
  async function handleCommand(cmd) {
    if (!cmd || typeof cmd.seq !== 'number' || cmd.seq <= lastSeq) return;
    lastSeq = cmd.seq;
    if (cmd.action === 'start') {
      await startJob(cmd.job);
    } else if (cmd.action === 'stop') {
      if (running) {
        cancelled = true;
        log('Stopping — saving the segments collected so far.');
        emit(true);
      }
    } else if (cmd.action === 'convert') {
      await convert();
    }
  }

  // Exposed for the host (offscreen.js on Chrome, background.js on Firefox).
  const AVD_Engine = {
    onState: null, // (state) => void
    onSave: null, //  (objectUrl, filename) => Promise<boolean>
    handleCommand,
  };
  globalThis.AVD_Engine = AVD_Engine;
})();
