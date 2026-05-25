// Adaptive Video Downloader — background
//
// Observes every network request and records HLS "seg-N" segment URLs per tab.
// For each distinct stream we keep only the freshest URL (the token is shared
// across segments) plus the highest segment number seen. The popup reads this
// to scan, test, and start a download.

const api = globalThis.browser ?? globalThis.chrome;

const SEG_RE = /seg-(\d+)/;
const STORE_KEY = 'avd:streams'; // session storage: { [tabId]: { [streamKey]: {url,max,min,count} } }
const SELF_ORIGIN = api.runtime.getURL('').replace(/\/$/, '');

let store = {};
let hydrated = false;
let hydrating = null;

function hydrate() {
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = api.storage.session
      .get(STORE_KEY)
      .then((d) => { store = (d && d[STORE_KEY]) || {}; hydrated = true; })
      .catch(() => { store = {}; hydrated = true; });
  }
  return hydrating;
}
const ready = hydrate();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api.storage.session.set({ [STORE_KEY]: store }).catch(() => {});
  }, 250);
}

function streamKeyOf(url) {
  return url.split('?')[0].replace(SEG_RE, 'seg-#');
}

function record(tabId, url) {
  if (tabId === undefined || tabId === null || tabId < 0) return;
  const m = url.match(SEG_RE);
  if (!m) return;
  const n = parseInt(m[1], 10);
  const key = streamKeyOf(url);
  const tabKey = String(tabId);
  const streams = (store[tabKey] = store[tabKey] || {});
  const entry = (streams[key] = streams[key] || { url, max: n, min: n, count: 0 });
  entry.url = url; // keep the freshest token
  entry.max = Math.max(entry.max, n);
  entry.min = Math.min(entry.min, n);
  entry.count += 1;
  scheduleSave();
}

function resetTab(tabId) {
  const tabKey = String(tabId);
  if (store[tabKey]) { delete store[tabKey]; scheduleSave(); }
}

api.webRequest.onBeforeRequest.addListener(
  (details) => {
    ready.then(() => {
      // Ignore the extension's own test/download requests.
      const origin = details.originUrl || details.initiator || details.documentUrl || '';
      if (origin && SELF_ORIGIN && origin.startsWith(SELF_ORIGIN)) return;

      if (details.type === 'main_frame') { resetTab(details.tabId); return; }
      if (details.url.indexOf('seg-') !== -1) record(details.tabId, details.url);
    });
  },
  { urls: ['<all_urls>'] }
);

api.tabs.onRemoved.addListener((tabId) => resetTab(tabId));

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await hydrate();
    if (msg && msg.type === 'getStreams') {
      const streams = store[String(msg.tabId)] || {};
      sendResponse({
        streams: Object.keys(streams).map((key) => {
          const v = streams[key];
          return { key, url: v.url, max: v.max, min: v.min, count: v.count };
        }),
      });
    } else {
      sendResponse({ error: 'unknown_message' });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});
