// Adaptive Video Downloader — progress / downloader page
const api = globalThis.browser ?? globalThis.chrome;
const SEG_RE = /seg-(\d+)/;
const $ = (id) => document.getElementById(id);

const MAX_SEG = 3000; // hard ceiling per the spec
const CONCURRENCY = 6; // parallel fetches (ordering + end-detection preserved)
const RETRIES = 2; // extra attempts after the first → 3 tries total

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
  if (!job || !job.template) {
    $('title').textContent = 'Download job not found';
    $('cancelBtn').classList.add('hidden');
    return;
  }

  template = job.template;
  label = job.label || 'video';
  knownMax = job.max || 0;

  $('title').textContent = 'Downloading video…';
  $('label').textContent = label;
  logLine('Source template: ' + template.replace(SEG_RE, 'seg-#'));
  logLine(`Fetching seg-1 … seg-${MAX_SEG} (stops at the first segment that fails ${RETRIES + 1} times).`);

  const startTime = Date.now();
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  finalize(startTime);
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
    for (let i = 0; i < finalParts.length; i++) {
      transmuxer.push(finalParts[i]);
      if (i % 25 === 0) {
        convStatus(`Remuxing to MP4… ${i + 1}/${finalParts.length} segments`);
        await new Promise((r) => setTimeout(r)); // yield so the UI stays responsive
      }
    }
    convStatus('Finalizing MP4…');
    await new Promise((r) => setTimeout(r));
    transmuxer.flush(); // emits the data + done events synchronously
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
  convStatus(`MP4 saved (${mb} MB) → ${fname}`);
  btn.textContent = 'MP4 saved ✓';
  logLine(`Converted to ${fname} (${mb} MB).`);
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
