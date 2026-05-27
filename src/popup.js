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

function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function startJob(job) {
  const jobId = newJobId();
  await api.storage.session.set({ ['avd:job:' + jobId]: { ...job, createdAt: Date.now() } });
  await api.tabs.create({ url: api.runtime.getURL('progress.html?job=' + jobId) });
  window.close();
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
  startJob({ kind: 'hls', template: s.url, label: labelFor(s.url), max: s.max, concurrency: conc, speed });
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
      startJob({ kind: 'file', url: m.url, label: mediaLabel(m.url), mime: m.mime });
    });

    item.appendChild(info);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

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
