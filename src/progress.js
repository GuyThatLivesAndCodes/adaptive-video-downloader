// Adaptive Video Downloader — progress / downloader page
const api = globalThis.browser ?? globalThis.chrome;
const SEG_RE = /seg-(\d+)/;
const $ = (id) => document.getElementById(id);

const MAX_SEG = 3000; // hard ceiling per the spec
const DEFAULT_CONCURRENCY = 6;
const RETRIES = 2; // extra attempts after the first → 3 tries total
let concurrency = DEFAULT_CONCURRENCY; // chosen per job (Normal/Fast/Hyper)

const jobId = new URLSearchParams(location.search).get('job');

let template = null;
let label = 'video';
let knownMax = 0;

let cancelled = false;
let nextN = 1;
let failedAt = Infinity;
const data = []; // data[n] = Uint8Array
let fetchedCount = 0;
let highestTried = 0;
const objectUrls = [];
let finalParts = null; // the merged TS segments, kept for optional MP4 conversion
let baseName = 'video';

function logLine(text) {
  const d = document.createElement('div');
  d.textContent = text;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
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

function updateUI() {
  $('stat').textContent = `${fetchedCount} segment(s) downloaded · scanning seg-${highestTried}`;
  // Length is unknown; show progress against a soft estimate so the bar moves.
  const estimate = Math.max(knownMax * 1.5, 60);
  const pct = Math.min(96, Math.round((highestTried / estimate) * 100));
  $('barFill').style.width = pct + '%';
}

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
      logLine(`seg-${n}: no response after ${RETRIES + 1} attempts → treating as end of video.`);
    } else {
      data[n] = new Uint8Array(buf);
      fetchedCount++;
      updateUI();
    }
  }
}

function finalize(startTime) {
  // Collect the contiguous run from seg-1 (guarantees a playable, gap-free file).
  const parts = [];
  let n = 1;
  while (n <= MAX_SEG && data[n]) {
    parts.push(data[n]);
    n++;
  }

  $('cancelBtn').classList.add('hidden');

  if (parts.length === 0) {
    $('title').textContent = 'No segments could be downloaded';
    $('barFill').style.width = '0%';
    $('stat').textContent =
      'The first segment did not respond. The link token may have expired — reload the video page and try again.';
    return;
  }

  baseName = sanitize(label);
  finalParts = parts;

  const blob = new Blob(parts, { type: 'video/mp2t' });
  const fname = baseName + '.ts';
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);

  // Trigger the download automatically…
  triggerDownload(url, fname);

  // …and expose a button as a fallback (in case the auto-download is blocked).
  const link = $('saveLink');
  link.href = url;
  link.download = fname;
  link.classList.remove('hidden');

  // Offer lossless MP4 conversion (remux of the .ts we just built).
  $('convertBtn').classList.remove('hidden');

  const secs = ((Date.now() - startTime) / 1000).toFixed(0);
  const mb = (blob.size / 1048576).toFixed(1);
  $('barFill').style.width = '100%';
  $('barFill').classList.add('done');
  $('title').textContent = cancelled ? 'Stopped — partial video saved' : 'Done! Video saved to Downloads';
  $('stat').textContent = `${parts.length} segments · ${mb} MB · ${secs}s → ${fname}`;
  logLine(`Merged ${parts.length} segments into ${fname} (${mb} MB).`);

  api.storage.session.remove('avd:job:' + jobId).catch(() => {});
}

async function run() {
  if (!jobId) {
    $('title').textContent = 'Download job not found';
    $('cancelBtn').classList.add('hidden');
    return;
  }
  const key = 'avd:job:' + jobId;
  const got = await api.storage.session.get(key);
  const job = got && got[key];
  if (!job || (!job.template && !job.url)) {
    $('title').textContent = 'Download job not found';
    $('cancelBtn').classList.add('hidden');
    return;
  }

  if (job.kind === 'file') {
    await runFile(job);
    return;
  }

  template = job.template;
  label = job.label || 'video';
  knownMax = job.max || 0;
  concurrency = Math.max(1, Math.min(64, job.concurrency || DEFAULT_CONCURRENCY));

  $('title').textContent = 'Downloading video…';
  $('label').textContent = label;
  logLine('Source template: ' + template.replace(SEG_RE, 'seg-#'));
  logLine(`Fetching seg-1 … seg-${MAX_SEG} (stops at the first segment that fails ${RETRIES + 1} times).`);
  logLine(`Up to ${concurrency} segments downloading at once${job.speed ? ' (' + job.speed + ' mode)' : ''}.`);

  const startTime = Date.now();
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  finalize(startTime);
}

// Direct progressive file (TikTok, Instagram, …): fetch one URL and save it.
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

async function runFile(job) {
  baseName = sanitize(job.label || 'video');
  $('title').textContent = 'Downloading file…';
  $('label').textContent = job.url.split('?')[0];
  logLine('Direct download: ' + job.url.split('?')[0]);
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
        if (total) $('barFill').style.width = Math.min(99, Math.round((received / total) * 100)) + '%';
        $('stat').textContent =
          `${(received / 1048576).toFixed(1)} MB` + (total ? ` / ${(total / 1048576).toFixed(1)} MB` : '');
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
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    triggerDownload(url, fname);

    const link = $('saveLink');
    link.href = url;
    link.download = fname;
    link.textContent = 'Save file';
    link.classList.remove('hidden');

    $('cancelBtn').classList.add('hidden');
    $('barFill').style.width = '100%';
    $('barFill').classList.add('done');
    const mb = (blob.size / 1048576).toFixed(1);
    const secs = ((Date.now() - startTime) / 1000).toFixed(0);
    $('title').textContent = cancelled ? 'Stopped — partial file saved' : 'Done! File saved to Downloads';
    $('stat').textContent = `${mb} MB · ${secs}s → ${fname}`;
    api.storage.session.remove('avd:job:' + jobId).catch(() => {});
  } catch (e) {
    $('title').textContent = 'Download failed';
    $('cancelBtn').classList.add('hidden');
    $('stat').textContent =
      (e && e.message ? e.message : String(e)) + ' — the link may require the original page or have expired.';
  }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function convStatus(text, isError) {
  const el = $('convStat');
  el.textContent = text;
  el.style.color = isError ? 'var(--danger)' : 'var(--muted)';
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
// out = [initSegment, fragment1, fragment2, …]; sum each fragment's media duration.
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

// Remux the merged MPEG-TS into a (fragmented) MP4 with mux.js — no re-encoding.
async function convertToMp4() {
  if (!finalParts || finalParts.length === 0) return;
  if (typeof muxjs === 'undefined' || !muxjs.Transmuxer) {
    convStatus('MP4 converter did not load.', true);
    return;
  }

  const btn = $('convertBtn');
  btn.disabled = true;
  btn.textContent = 'Converting…';

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
    // Flush after EACH segment. mux.js must process one segment per flush cycle;
    // pushing them all and flushing once makes it compute a frame duration across
    // a segment boundary where the decode timestamp jumps backwards, which gets
    // encoded as an unsigned 32-bit value (~2^32 ticks ≈ 13h) and inflates the
    // total duration. Per-segment flushing keeps each fragment's timing correct.
    for (let i = 0; i < finalParts.length; i++) {
      transmuxer.push(finalParts[i]);
      transmuxer.flush();
      if (i % 20 === 0) {
        convStatus(`Remuxing to MP4… ${i + 1}/${finalParts.length} segments`);
        await new Promise((r) => setTimeout(r)); // keep the UI responsive
      }
    }
  } catch (e) {
    convStatus('Conversion failed: ' + (e && e.message ? e.message : e), true);
    btn.disabled = false;
    btn.textContent = 'Convert to MP4';
    return;
  }

  if (!sawData || out.length === 0) {
    convStatus('Could not convert — the stream likely uses a codec other than H.264/AAC. Your .ts file is still saved.', true);
    btn.disabled = false;
    btn.textContent = 'Convert to MP4';
    return;
  }

  const blob = new Blob(out, { type: 'video/mp4' });
  const fname = baseName + '.mp4';
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  triggerDownload(url, fname);

  const link = $('mp4Link');
  link.href = url;
  link.download = fname;
  link.classList.remove('hidden');

  const mb = (blob.size / 1048576).toFixed(1);
  const durSecs = mp4DurationSeconds(out);
  const durStr = durSecs ? ` · ${formatTime(durSecs)}` : '';
  convStatus(`MP4 saved (${mb} MB${durStr}) → ${fname}`);
  btn.textContent = 'MP4 saved ✓';
  logLine(`Converted to ${fname} (${mb} MB${durStr}).`);
}

$('cancelBtn').addEventListener('click', () => {
  cancelled = true;
  $('cancelBtn').textContent = 'Stopping…';
  logLine('Stopping — will save the segments collected so far.');
});

$('convertBtn').addEventListener('click', convertToMp4);

window.addEventListener('beforeunload', () => {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
});

run();
