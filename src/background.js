// Adaptive Video Downloader — background
//
// Observes network traffic per tab and records two kinds of downloadable media:
//   1. HLS "seg-N" segment streams (iterated by number) — the original method.
//   2. Direct video files (mp4/webm/mov/…) detected by Content-Type or file
//      extension — covers sites like TikTok and many Instagram videos that
//      serve one progressive file instead of numbered HLS segments.

const api = globalThis.browser ?? globalThis.chrome;

const SEG_RE = /seg-(\d+)/;
const MEDIA_EXT_RE = /\.(mp4|m4v|webm|mov|ogv)(\?|$)/i;
const STREAMS_KEY = 'avd:streams'; // { [tabId]: { [streamKey]: {url,max,min,count} } }
const MEDIA_KEY = 'avd:media'; //    { [tabId]: [ {url,mime,size,ts} ] }
const SELF_ORIGIN = api.runtime.getURL('').replace(/\/$/, '');

let streamStore = {};
let mediaStore = {};
let hydrated = false;
let hydrating = null;

function hydrate() {
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = api.storage.session
      .get([STREAMS_KEY, MEDIA_KEY])
      .then((d) => {
        streamStore = (d && d[STREAMS_KEY]) || {};
        mediaStore = (d && d[MEDIA_KEY]) || {};
        hydrated = true;
      })
      .catch(() => { streamStore = {}; mediaStore = {}; hydrated = true; });
  }
  return hydrating;
}
const ready = hydrate();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api.storage.session.set({ [STREAMS_KEY]: streamStore, [MEDIA_KEY]: mediaStore }).catch(() => {});
  }, 250);
}

function isSelf(details) {
  const origin = details.originUrl || details.initiator || details.documentUrl || '';
  return !!(origin && SELF_ORIGIN && origin.startsWith(SELF_ORIGIN));
}

function streamKeyOf(url) {
  return url.split('?')[0].replace(SEG_RE, 'seg-#');
}

function recordSeg(tabId, url) {
  if (tabId == null || tabId < 0) return;
  const m = url.match(SEG_RE);
  if (!m) return;
  const n = parseInt(m[1], 10);
  const key = streamKeyOf(url);
  const tabKey = String(tabId);
  const streams = (streamStore[tabKey] = streamStore[tabKey] || {});
  const entry = (streams[key] = streams[key] || { url, max: n, min: n, count: 0 });
  entry.url = url; // keep the freshest token
  entry.max = Math.max(entry.max, n);
  entry.min = Math.min(entry.min, n);
  entry.count += 1;
  scheduleSave();
}

// video/* except the transport-stream segments handled by the seg path.
function mediaMimeKind(mime) {
  if (!mime) return null;
  const m = mime.split(';')[0].trim().toLowerCase();
  if (m === 'video/mp2t') return null;
  if (!m.startsWith('video/')) return null;
  return 'file';
}

function recordMedia(tabId, url, mime, size) {
  if (tabId == null || tabId < 0) return;
  if (url.indexOf('seg-') !== -1) return; // belongs to the HLS seg path
  if (/^(data|blob):/i.test(url)) return;
  // YouTube (googlevideo) is throttled, DASH, separate audio/video — it can't be
  // saved as one progressive file, so don't list it as a downloadable file.
  if (/googlevideo\.com/i.test(url)) return;
  const tabKey = String(tabId);
  const list = (mediaStore[tabKey] = mediaStore[tabKey] || []);
  const existing = list.find((x) => x.url === url);
  if (existing) {
    if (size && size > (existing.size || 0)) existing.size = size;
    if (mime && !existing.mime) existing.mime = mime;
    return;
  }
  list.push({ url, mime: mime || '', size: size || 0, ts: Date.now() });
  while (list.length > 20) list.shift();
  scheduleSave();
}

function resetTab(tabId) {
  const k = String(tabId);
  let changed = false;
  if (streamStore[k]) { delete streamStore[k]; changed = true; }
  if (mediaStore[k]) { delete mediaStore[k]; changed = true; }
  if (changed) scheduleSave();
}

api.webRequest.onBeforeRequest.addListener(
  (details) => {
    ready.then(() => {
      if (isSelf(details)) return;
      if (details.type === 'main_frame') { resetTab(details.tabId); return; }
      if (details.url.indexOf('seg-') !== -1) recordSeg(details.tabId, details.url);
      else if (MEDIA_EXT_RE.test(details.url.split('#')[0])) recordMedia(details.tabId, details.url, '', 0);
    });
  },
  { urls: ['<all_urls>'] }
);

// Catch extensionless media (TikTok/Instagram CDN URLs) by Content-Type.
api.webRequest.onHeadersReceived.addListener(
  (details) => {
    ready.then(() => {
      if (isSelf(details)) return;
      const headers = details.responseHeaders || [];
      let mime = '';
      let size = 0;
      for (let i = 0; i < headers.length; i++) {
        const name = headers[i].name.toLowerCase();
        const val = headers[i].value || '';
        if (name === 'content-type') mime = val;
        else if (name === 'content-length') { if (!size) size = parseInt(val, 10) || 0; }
        else if (name === 'content-range') { const mm = /\/(\d+)\s*$/.exec(val); if (mm) size = parseInt(mm[1], 10) || size; }
      }
      if (mediaMimeKind(mime) === 'file') recordMedia(details.tabId, details.url, mime, size);
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

api.tabs.onRemoved.addListener((tabId) => resetTab(tabId));

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await hydrate();
    if (msg && msg.type === 'getStreams') {
      const tabKey = String(msg.tabId);
      const streams = streamStore[tabKey] || {};
      const mediaList = (mediaStore[tabKey] || []).slice().reverse(); // newest first
      sendResponse({
        streams: Object.keys(streams).map((key) => {
          const v = streams[key];
          return { key, url: v.url, max: v.max, min: v.min, count: v.count };
        }),
        media: mediaList.map((m) => ({ url: m.url, mime: m.mime, size: m.size })),
      });
    } else {
      sendResponse({ error: 'unknown_message' });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});
