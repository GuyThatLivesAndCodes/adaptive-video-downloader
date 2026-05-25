// Adaptive Video Downloader — popup
const api = globalThis.browser ?? globalThis.chrome;
const SEG_RE = /seg-(\d+)/;
const $ = (id) => document.getElementById(id);

let streams = [];

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

function current() {
  return streams[parseInt($('streamSel').value || '0', 10)] || streams[0];
}

function updateMeta() {
  const s = current();
  $('meta').textContent = `${s.count} segment request(s) seen · highest seg-${s.max}`;
}

function renderStreams() {
  $('status').classList.add('hidden');
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

function showNone() {
  $('status').textContent = 'No video segments detected on this tab yet.';
  $('hint').classList.remove('hidden');
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

$('downloadBtn').addEventListener('click', async () => {
  const s = current();
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await api.storage.session.set({
    ['avd:job:' + jobId]: {
      template: s.url,
      label: labelFor(s.url),
      max: s.max,
      createdAt: Date.now(),
    },
  });
  await api.tabs.create({ url: api.runtime.getURL('progress.html?job=' + jobId) });
  window.close();
});

async function init() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) { showNone(); return; }

  let resp = null;
  try {
    resp = await api.runtime.sendMessage({ type: 'getStreams', tabId: tab.id });
  } catch (e) {
    resp = null;
  }
  streams = (resp && resp.streams) || [];
  if (streams.length === 0) { showNone(); return; }

  streams.sort((a, b) => b.count - a.count);
  renderStreams();
  await runRandomTest();
  $('downloadBtn').classList.remove('hidden');
}

init();
