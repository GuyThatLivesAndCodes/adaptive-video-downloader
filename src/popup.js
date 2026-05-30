// Adaptive Video Downloader — popup
const api = globalThis.browser ?? globalThis.chrome;
const SEG_RE = /seg-(\d+)/;
const $ = (id) => document.getElementById(id);

let streams = [];
let media = [];

// Sites we deliberately don't support: YouTube (throttled DASH + ToS) and
// DRM-protected services (content is encrypted — can't and won't be bypassed).
const UNSUPPORTED_SITES = [
  {
    hosts: ['youtube.com', 'youtu.be'],
    name: 'YouTube',
    reason:
      'YouTube serves throttled DASH streams (separate audio and video) that need its obfuscated player code to download, and doing so is against its Terms of Service.',
  },
  { hosts: ['netflix.com'], name: 'Netflix', drm: true },
  { hosts: ['disneyplus.com'], name: 'Disney+', drm: true },
  { hosts: ['hulu.com'], name: 'Hulu', drm: true },
  { hosts: ['max.com', 'hbomax.com'], name: 'Max', drm: true },
  { hosts: ['primevideo.com'], name: 'Prime Video', drm: true },
  { hosts: ['tv.apple.com'], name: 'Apple TV+', drm: true },
  { hosts: ['open.spotify.com', 'spotify.com'], name: 'Spotify', drm: true },
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

function matchUnsupported(host) {
  if (!host) return null;
  return (
    UNSUPPORTED_SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h))) || null
  );
}

function reasonFor(site) {
  if (site.reason) return site.reason;
  if (site.drm) {
    return `Video on ${site.name} is protected by DRM (encrypted), so it can't be downloaded — and this extension won't bypass DRM.`;
  }
  return `${site.name} isn't supported.`;
}

function showLockdown(site) {
  document.body.classList.add('locked');
  $('status').classList.add('hidden');
  $('lockSite').textContent = site.name;
  $('lockReason').textContent = reasonFor(site);
  $('lockdown').classList.remove('hidden');
}

function buildSegUrl(template, n) {
  return template.replace(SEG_RE, 'seg-' + n);
}

function labelFor(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.findIndex((p) => SEG_RE.test(p));
    let name = i > 0 ? parts[i - 1] : parts[i] || u.hostname;
    name = decodeURIComponent(name);
    if (name.length > 40) name = name.slice(0, 38) + '…';
    return name || u.hostname;
  } catch (e) {
    return 'video';
  }
}

function mediaLabel(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    let name = decodeURIComponent(parts[parts.length - 1] || '');
    if (!/\.[a-z0-9]{2,4}$/i.test(name)) name = u.hostname; // no real filename → host
    if (name.length > 34) name = name.slice(0, 32) + '…';
    return name || 'video';
  } catch (e) {
    return 'video';
  }
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// Switch the popup from the scan view to the in-popup download view and start
// fetching. Everything runs right here in the popup — no separate tab opens.
function startDownload(job) {
  ['status', 'streamWrap', 'mediaWrap', 'hint', 'lockdown'].forEach((id) =>
    $(id).classList.add('hidden')
  );
  $('progressView').classList.remove('hidden');
  runDownload(job);
}

/* ---------- HLS segment streams ---------- */

function current() {
  return streams[parseInt($('streamSel').value || '0', 10)] || streams[0];
}

function updateMeta() {
  const s = current();
  $('meta').textContent = `${s.count} segment request(s) seen · highest seg-${s.max}`;
}

function activeConcurrency() {
  const btn = $('speedSeg').querySelector('button.active') || $('speedSeg').querySelector('button');
  return { conc: parseInt(btn.dataset.conc, 10) || 6, speed: btn.dataset.speed || 'normal' };
}

function setSpeed(speed) {
  $('speedSeg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.speed === speed);
  });
  api.storage.local.set({ 'avd:speed': speed }).catch(() => {});
}

function renderStreams() {
  $('streamWrap').classList.remove('hidden');
  const sel = $('streamSel');
  sel.innerHTML = '';
  streams.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = labelFor(s.url);
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => { updateMeta(); runRandomTest(); });
  updateMeta();
}

async function runRandomTest() {
  const s = current();
  const upper = Math.max(s.max, 2);
  const n = 1 + Math.floor(Math.random() * upper); // arbitrary segment within the stream
  const url = buildSegUrl(s.url, n);
  const el = $('testResult');
  el.className = 'test';
  el.classList.remove('hidden');
  el.textContent = `Testing a random segment (seg-${n})…`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
    if (res.ok) {
      el.classList.add('ok');
      el.textContent = `Server answered random seg-${n} (HTTP ${res.status}). Ready to download.`;
    } else {
      el.classList.add('warn');
      el.textContent = `Random seg-${n} returned HTTP ${res.status}. You can still try the download.`;
    }
  } catch (e) {
    el.classList.add('warn');
    el.textContent = `Random seg-${n} request failed (${e.message || 'network error'}). You can still try the download.`;
  }
}

$('downloadBtn').addEventListener('click', () => {
  const s = current();
  const { conc, speed } = activeConcurrency();
  startDownload({ kind: 'hls', template: s.url, label: labelFor(s.url), max: s.max, concurrency: conc, speed });
});

$('speedSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-speed]');
  if (btn) setSpeed(btn.dataset.speed);
});

/* ---------- Direct media files ---------- */

function renderMedia() {
  if (media.length === 0) return;
  $('mediaWrap').classList.remove('hidden');
  const list = $('mediaList');
  list.innerHTML = '';
  media.forEach((m) => {
    const item = document.createElement('div');
    item.className = 'media-item';

    const info = document.createElement('div');
    info.className = 'media-info';
    const name = document.createElement('span');
    name.className = 'media-name';
    name.textContent = mediaLabel(m.url);
    const sub = document.createElement('span');
    sub.className = 'media-sub';
    const type = (m.mime || '').split('/')[1] || 'video';
    sub.textContent = [formatSize(m.size), type].filter(Boolean).join(' · ');
    info.appendChild(name);
    info.appendChild(sub);

    const btn = document.createElement('button');
    btn.className = 'media-dl';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => {
      startDownload({ kind: 'file', url: m.url, label: mediaLabel(m.url), mime: m.mime });
    });

    item.appendChild(info);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

/* ---------- in-popup downloader (segments or direct file, merge, save, convert) ---------- */

const MAX_SEG = 3000; // hard ceiling per the spec
const DEFAULT_CONCURRENCY = 6;
const RETRIES = 2; // extra attempts after the first → 3 tries total

let concurrency = DEFAULT_CONCURRENCY; // chosen per job (Normal/Fast/Hyper)
let template = null;
let dlName = 'video';
let knownMax = 0;
let cancelled = false;
let nextN = 1;
let failedAt = Infinity;
let data = []; // data[n] = Uint8Array
let fetchedCount = 0;
let highestTried = 0;
const objectUrls = [];
let finalParts = null; // the merged TS segments, kept for optional MP4 conversion
let baseName = 'video';

function runDownload(job) {
  if (job.kind === 'file') return runFile(job);
  return runHls(job);
}

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

function updateDlUI() {
  $('stat').textContent = `${fetchedCount} segment(s) downloaded · scanning seg-${highestTried}`;
  // Length is unknown; show progress against a soft estimate so the bar moves.
  const estimate = Math.max(knownMax * 1.5, 60);
  const pct = Math.min(96, Math.round((highestTried / estimate) * 100));
  $('barFill').style.width = pct + '%';
}

async function fetchSeg(n) {
  const url = buildSegUrl(template, n);
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
      updateDlUI();
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
    $('dlTitle').textContent = 'No segments could be downloaded';
    $('barFill').style.width = '0%';
    $('stat').textContent =
      'The first segment did not respond. The link token may have expired — reload the video page and try again.';
    return;
  }

  baseName = sanitize(dlName);
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
  $('dlTitle').textContent = cancelled ? 'Stopped — partial video saved' : 'Done! Video saved to Downloads';
  $('stat').textContent = `${parts.length} segments · ${mb} MB · ${secs}s → ${fname}`;
  logLine(`Merged ${parts.length} segments into ${fname} (${mb} MB).`);
}

async function runHls(job) {
  template = job.template;
  dlName = job.label || 'video';
  knownMax = job.max || 0;
  concurrency = Math.max(1, Math.min(64, job.concurrency || DEFAULT_CONCURRENCY));

  $('dlTitle').textContent = 'Downloading video…';
  $('dlLabel').textContent = dlName;
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
  $('dlTitle').textContent = 'Downloading file…';
  $('dlLabel').textContent = job.url.split('?')[0];
  $('convertBtn').classList.add('hidden'); // MP4 conversion is for HLS .ts only
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
    $('dlTitle').textContent = cancelled ? 'Stopped — partial file saved' : 'Done! File saved to Downloads';
    $('stat').textContent = `${mb} MB · ${secs}s → ${fname}`;
  } catch (e) {
    $('dlTitle').textContent = 'Download failed';
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

// mux.js (~70 KB) is only needed for the optional MP4 conversion, so it's
// loaded on demand the first time the user asks for it — keeps the popup snappy.
let muxLoading = null;
function loadMuxjs() {
  if (typeof muxjs !== 'undefined' && muxjs.Transmuxer) return Promise.resolve();
  if (muxLoading) return muxLoading;
  muxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/mux-mp4.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load the MP4 converter'));
    document.head.appendChild(s);
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

  const btn = $('convertBtn');
  btn.disabled = true;
  btn.textContent = 'Converting…';

  try {
    await loadMuxjs();
  } catch (e) {
    convStatus('MP4 converter did not load.', true);
    btn.disabled = false;
    btn.textContent = 'Convert to MP4';
    return;
  }
  if (typeof muxjs === 'undefined' || !muxjs.Transmuxer) {
    convStatus('MP4 converter did not load.', true);
    btn.disabled = false;
    btn.textContent = 'Convert to MP4';
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

// "Back" returns to the scan list. Reloading gives a clean slate (and re-scans
// the tab); any in-progress download is intentionally abandoned.
$('backBtn').addEventListener('click', () => location.reload());

window.addEventListener('beforeunload', () => {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
});

/* ---------- init ---------- */

function showNone() {
  $('status').textContent = 'No video detected on this tab yet.';
  $('hint').classList.remove('hidden');
}

async function init() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) { showNone(); return; }

  // Sites we can't support get a clear red lockdown view instead of an empty scan.
  const blocked = matchUnsupported(hostnameOf(tab.url || ''));
  if (blocked) { showLockdown(blocked); return; }

  let resp = null;
  try {
    resp = await api.runtime.sendMessage({ type: 'getStreams', tabId: tab.id });
  } catch (e) {
    resp = null;
  }
  streams = (resp && resp.streams) || [];
  media = (resp && resp.media) || [];

  if (streams.length === 0 && media.length === 0) { showNone(); return; }
  $('status').classList.add('hidden');

  // restore the saved speed preference
  try {
    const pref = await api.storage.local.get('avd:speed');
    setSpeed((pref && pref['avd:speed']) || 'normal');
  } catch (e) {
    setSpeed('normal');
  }

  if (streams.length > 0) {
    streams.sort((a, b) => b.count - a.count);
    renderStreams();
    await runRandomTest();
  }
  renderMedia();
}

init();
