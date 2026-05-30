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
  const MAX_SEG = 3000; // hard ceiling per the spec
  const DEFAULT_CONCURRENCY = 6;
  const RETRIES = 2; // extra attempts after the first → 3 tries total
  const LOG_CAP = 60;

  // ---- per-job state ----
  let job = null;
  let segPre = ''; // segment URL = segPre + <number> + segPost
  let segPost = '';
  let segPad = 0; // zero-pad width for the index (0 = none)
  let startN = 1; // first segment index to try
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
    const num = segPad > 0 ? String(n).padStart(segPad, '0') : String(n);
    return segPre + num + segPost;
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
        log(`segment #${n}: no response after ${RETRIES + 1} attempts → treating as end of video.`);
      } else {
        data[n] = new Uint8Array(buf);
        fetchedCount++;
        S.stat = `${fetchedCount} segment(s) downloaded · scanning #${highestTried}`;
        const estimate = Math.max((job.max || 0) * 1.5, 60);
        S.pct = Math.min(96, Math.round((highestTried / estimate) * 100));
        emit();
      }
    }
  }

  async function runHls() {
    if (!job.pre || typeof job.pre !== 'string') {
      S.phase = 'error';
      S.title = 'Stream info missing';
      S.stat = 'Reload the video page and scan again, then download.';
      S.canStop = false;
      emit(true);
      return;
    }
    segPre = job.pre;
    segPost = job.post || '';
    segPad = job.pad || 0;
    startN = job.start === 0 ? 0 : 1;
    nextN = startN;
    concurrency = Math.max(1, Math.min(64, job.concurrency || DEFAULT_CONCURRENCY));

    S.title = 'Downloading video…';
    S.label = job.label || 'video';
    S.canStop = true;
    log('Segment template: ' + segPre + '#' + segPost.split('?')[0]);
    log(`Fetching #${startN} … #${MAX_SEG} (stops at the first that fails ${RETRIES + 1} times).`);
    log(`Up to ${concurrency} segments at once${job.speed ? ' (' + job.speed + ' mode)' : ''}.`);
    emit(true);

    const startTime = Date.now();
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);
    await finalizeHls(startTime);
  }

  async function finalizeHls(startTime) {
    // Contiguous run from the first segment guarantees a playable, gap-free file.
    const parts = [];
    let n = startN;
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

  /* ---------- MP4 conversion via ffmpeg.wasm (lazy-loaded) ---------- */
  //
  // Runs exactly what you'd run by hand — `ffmpeg -i input.ts -c copy
  // output.mp4` — inside a WebAssembly ffmpeg. A stream copy (no re-encode) is
  // fast and lossless, repairs timestamps, and handles whatever codecs the
  // source uses (H.264, HEVC, AAC, AC-3, …) instead of the old remuxer's
  // H.264/AAC-only path. ffmpeg runs in its own worker that the wrapper spawns;
  // the ~32 MB core is initialised on first use and torn down afterwards.

  let ff = null; // FFmpeg instance while loaded
  let ffLoading = null;

  function ffUrl(file) {
    // Resolve against this context's own document (offscreen.html / bg page).
    return new URL('vendor/ffmpeg/' + file, location.href).href;
  }

  function loadFFmpegScript() {
    if (globalThis.FFmpegWASM && globalThis.FFmpegWASM.FFmpeg) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const doc = typeof document !== 'undefined' ? document : null;
      if (!doc) {
        reject(new Error('no DOM available to load ffmpeg'));
        return;
      }
      const s = doc.createElement('script');
      s.src = ffUrl('ffmpeg.js'); // UMD build → globalThis.FFmpegWASM
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ffmpeg.js'));
      (doc.head || doc.documentElement).appendChild(s);
    });
  }

  async function getFFmpeg() {
    if (ff && ff.loaded) return ff;
    if (!ffLoading) {
      ffLoading = (async () => {
        await loadFFmpegScript();
        const inst = new globalThis.FFmpegWASM.FFmpeg();
        inst.on('progress', ({ progress }) => {
          if (S.convert.state !== 'running') return;
          if (typeof progress === 'number' && progress >= 0 && progress <= 1) {
            S.convert.status = `Converting to MP4 (stream copy)… ${Math.min(99, Math.round(progress * 100))}%`;
            emit();
          }
        });
        // Same-origin UMD core; the wrapper auto-loads its classic worker
        // (vendor/ffmpeg/814.ffmpeg.js) relative to ffmpeg.js.
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

  function concatParts(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
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
    S.convert.status = 'Loading the MP4 converter (first use initialises ~32 MB)…';
    emit(true);

    let ffmpeg;
    try {
      ffmpeg = await getFFmpeg();
    } catch (e) {
      S.convert.state = 'error';
      S.convert.status = 'MP4 converter (ffmpeg) failed to load: ' + (e && e.message ? e.message : e);
      emit(true);
      return;
    }

    try {
      const input = concatParts(finalParts);
      S.convert.status = 'Converting to MP4 (stream copy)…';
      emit(true);
      await ffmpeg.writeFile('input.ts', input);
      // ffmpeg -i input.ts -c copy -movflags +faststart output.mp4
      const code = await ffmpeg.exec([
        '-i', 'input.ts',
        '-c', 'copy',
        '-movflags', '+faststart',
        'output.mp4',
      ]);
      if (code !== 0) throw new Error('ffmpeg exited with code ' + code);
      const out = await ffmpeg.readFile('output.mp4'); // Uint8Array
      if (!out || !out.length) throw new Error('no output produced');
      try { await ffmpeg.deleteFile('input.ts'); } catch (e) {}
      try { await ffmpeg.deleteFile('output.mp4'); } catch (e) {}

      const blob = new Blob([out], { type: 'video/mp4' });
      const fname = baseName + '.mp4';
      const ok = await save(blob, fname);
      const mb = (blob.size / 1048576).toFixed(1);
      S.convert.state = 'done';
      S.convert.name = fname;
      S.convert.status = `MP4 saved (${mb} MB) → ${fname}` + (ok ? '' : ' (auto-save failed)');
      log(`Converted to ${fname} with ffmpeg -c copy (${mb} MB).`);
      emit(true);
    } catch (e) {
      S.convert.state = 'error';
      S.convert.status =
        'Conversion failed: ' + (e && e.message ? e.message : e) + '. Your .ts file is still saved.';
      emit(true);
    } finally {
      // Release the ~32 MB core; it reloads on the next conversion.
      try {
        if (ff) ff.terminate();
      } catch (e) {}
      ff = null;
    }
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
