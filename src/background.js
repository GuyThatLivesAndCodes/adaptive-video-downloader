// Adaptive Video Downloader — background
//
// Observes network traffic per tab and logs every video-ish request so the
// popup can show the user all candidates to pick from. Two kinds are recorded:
//   1. Numbered segment streams (HLS) — any URL with an incrementing index
//      (seg-12, segment_12, chunk12, frag-12, 00012.ts, …). URLs that differ
//      only by that index converge into one downloadable template.
//   2. Encrypted HLS/DASH streams — automatically detected via manifest headers
//   3. Direct video files (mp4/webm/mov/ts/…) detected by file extension or
//      Content-Type — one progressive file, downloaded whole.

const api = globalThis.browser ?? globalThis.chrome;

// Cache for detected encrypted/DASH streams
const encryptedStreams = new Map();

// Extensions we treat as downloadable video.
const VIDEO_EXT_RE = /\.(ts|mp4|m4v|m4s|webm|mov|ogv)(\?|#|$)/i;
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
        pruneStreams(); // drop entries from an older storage format (no pre/post)
        hydrated = true;
      })
      .catch(() => { streamStore = {}; mediaStore = {}; hydrated = true; });
  }
  return hydrating;
}

// A previous version stored streams as { url, max, min, count }; this version
// needs { pre, post, pad, … }. Discard anything that doesn't match the current
// shape so stale data can't poison the list (it would build "undefinedN.ts").
function pruneStreams() {
  let changed = false;
  for (const tab of Object.keys(streamStore)) {
    const streams = streamStore[tab] || {};
    for (const key of Object.keys(streams)) {
      const v = streams[key];
      if (!v || typeof v.pre !== 'string' || typeof v.post !== 'string') {
        delete streams[key];
        changed = true;
      }
    }
    if (Object.keys(streams).length === 0) delete streamStore[tab];
  }
  if (changed) scheduleSave();
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

/* ---------- download coordinator (popup ⇄ engine) ---------- */
// The download engine runs in a persistent context so it survives the popup
// closing: an offscreen document on Chrome (created on demand) or this very
// background page on Firefox (where engine.js is loaded alongside this script
// via manifest "background.scripts"). The popup talks to the engine only
// through here; progress is mirrored into storage.session ('avd:state') for the
// popup to render, and the finished blob is saved via the Downloads API.
const STATE_KEY = 'avd:state';
const FIREFOX_ENGINE = !!globalThis.AVD_Engine; // engine is in this page (Firefox)

let lastAssignedSeq = 0;
function nextSeq() {
  // Monotonic across service-worker restarts (de-dupes commands in the engine).
  lastAssignedSeq = Math.max(Date.now(), lastAssignedSeq + 1);
  return lastAssignedSeq;
}

function publishState(state) {
  api.storage.session.set({ [STATE_KEY]: state }).catch(() => {});
}

// Firefox: the engine lives in this page, so connect its outputs to the
// privileged APIs directly (offscreen documents can't, hence the message dance
// on Chrome below).
if (FIREFOX_ENGINE) {
  globalThis.AVD_Engine.onState = (state) => publishState(state);
  globalThis.AVD_Engine.onSave = (url, filename) =>
    api.downloads.download({ url, filename, saveAs: false }).then(() => true).catch(() => false);
}

let offscreenCreating = null;
async function ensureOffscreen() {
  if (!api.offscreen || !api.offscreen.createDocument) return; // Firefox / unsupported
  try {
    if (api.offscreen.hasDocument) {
      if (await api.offscreen.hasDocument()) return;
    } else if (api.runtime.getContexts) {
      const ctx = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctx && ctx.length) return;
    }
  } catch (e) {
    /* fall through and try to create */
  }
  if (!offscreenCreating) {
    offscreenCreating = api.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification:
          'Keep downloading and assembling the video in the background after the popup closes.',
      })
      .catch((e) => {
        // A concurrent create may already have made it — that's fine.
        if (!/already|single offscreen/i.test(String(e && e.message))) throw e;
      });
  }
  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

let pendingCmd = null;
async function routeCommand(cmd) {
  if (FIREFOX_ENGINE) {
    globalThis.AVD_Engine.handleCommand(cmd);
    return;
  }
  await ensureOffscreen();
  // Remember the command briefly so a just-created document can pull it via its
  // 'ready' ping; also send it now in case the document is already listening
  // (the engine de-dupes by seq, so a double delivery is harmless).
  pendingCmd = cmd;
  setTimeout(() => { if (pendingCmd === cmd) pendingCmd = null; }, 3000);
  api.runtime.sendMessage({ type: 'avd:engine:cmd', cmd }).catch(() => {});
}

function isSelf(details) {
  const origin = details.originUrl || details.initiator || details.documentUrl || '';
  return !!(origin && SELF_ORIGIN && origin.startsWith(SELF_ORIGIN));
}

// Segment-specific tokens followed by the index, plus a fallback for a bare
// trailing number on transport-stream/fMP4 segments (00012.ts, media_1.ts).
// Tokens are kept tight (seg/segment/chunk/frag/fragment) so generic words that
// appear as directories (media, part) don't get mistaken for an index.
const SEG_TOKEN_RE = /(seg(?:ment)?|chunk|frag(?:ment)?)[-_]?(\d+)/gi;
const TS_TRAILING_RE = /(\d+)(\.(?:ts|m4s))$/i;

// Split a URL around its segment index so it can be rebuilt for any number.
// Returns { pre, post, n, pad } or null when the URL isn't a numbered segment.
// The index is searched only within the PATH (never the host), and `post` keeps
// the query string so the (freshest) signed token rides along.
function findSegIndex(fullUrl) {
  let u;
  try { u = new URL(fullUrl); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const path = u.pathname;
  const query = u.search || '';

  let start = -1;
  let len = 0;
  SEG_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = SEG_TOKEN_RE.exec(path))) {
    len = m[2].length; // last token wins (closest to the filename)
    start = m.index + m[0].length - len;
  }
  if (start < 0) {
    const t = TS_TRAILING_RE.exec(path);
    if (t) { start = t.index; len = t[1].length; }
  }
  if (start < 0) return null;

  const digits = path.slice(start, start + len);
  return {
    pre: u.origin + path.slice(0, start),
    post: path.slice(start + len) + query,
    n: parseInt(digits, 10),
    pad: digits[0] === '0' ? len : 0, // preserve zero-padding (00012 → width 5)
  };
}

// Token-independent grouping: path structure with the index blanked and the
// query dropped. Other numbers (e.g. 720p) stay, so resolutions stay separate.
function familyKeyOf(seg) {
  return seg.pre + '#' + seg.post.split('?')[0];
}

function extOf(url) {
  const m = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(url.split('#')[0]);
  return m ? m[1].toLowerCase() : '';
}

function recordSeg(tabId, url, seg) {
  if (tabId == null || tabId < 0) return;
  if (!seg) seg = findSegIndex(url);
  if (!seg) return;
  const key = familyKeyOf(seg);
  const tabKey = String(tabId);
  const streams = (streamStore[tabKey] = streamStore[tabKey] || {});
  const entry =
    streams[key] ||
    (streams[key] = { pre: seg.pre, post: seg.post, pad: seg.pad, min: seg.n, max: seg.n, count: 0, ext: extOf(url) });
  entry.pre = seg.pre; // refresh to the freshest token
  entry.post = seg.post;
  entry.pad = seg.pad;
  entry.min = Math.min(entry.min, seg.n);
  entry.max = Math.max(entry.max, seg.n);
  entry.count += 1;
  scheduleSave();
}

function isVideoFileUrl(url) {
  return VIDEO_EXT_RE.test(url.split('#')[0]);
}

function mediaMimeKind(mime) {
  if (!mime) return null;
  const m = mime.split(';')[0].trim().toLowerCase();
  if (!m.startsWith('video/')) return null;
  return 'file';
}

function recordMedia(tabId, url, mime, size) {
  if (tabId == null || tabId < 0) return;
  if (/^(data|blob):/i.test(url)) return;
  if (findSegIndex(url)) return; // numbered segment → handled as a stream
  // YouTube (googlevideo) is throttled DASH with separate audio/video — it can't
  // be saved as one progressive file, so don't list it as a downloadable file.
  if (/googlevideo\.com/i.test(url)) return;
  const tabKey = String(tabId);
  const list = (mediaStore[tabKey] = mediaStore[tabKey] || []);
  const bare = url.split('?')[0];
  const existing = list.find((x) => x.url.split('?')[0] === bare);
  if (existing) {
    existing.url = url; // freshest token
    if (size && size > (existing.size || 0)) existing.size = size;
    if (mime && !existing.mime) existing.mime = mime;
    return;
  }
  list.push({ url, mime: mime || '', size: size || 0, ts: Date.now() });
  while (list.length > 30) list.shift();
  scheduleSave();
}

function resetTab(tabId) {
  const k = String(tabId);
  let changed = false;
  if (streamStore[k]) { delete streamStore[k]; changed = true; }
  if (mediaStore[k]) { delete mediaStore[k]; changed = true; }
  if (changed) scheduleSave();
}

function isManifestUrl(url) {
  const lower = url.toLowerCase();
  return lower.includes('.m3u8') || lower.includes('.mpd') || lower.includes('manifest');
}

function recordManifest(tabId, url) {
  if (tabId == null || tabId < 0) return;
  const tabKey = String(tabId);
  const key = `manifest_${url.split('?')[0]}`;
  if (!encryptedStreams.has(key)) {
    encryptedStreams.set(key, { url, tabId, ts: Date.now() });
  }
}

api.webRequest.onBeforeRequest.addListener(
  (details) => {
    ready.then(() => {
      if (isSelf(details)) return;
      if (details.type === 'main_frame') { resetTab(details.tabId); return; }
      if (isManifestUrl(details.url)) { recordManifest(details.tabId, details.url); return; }
      const seg = findSegIndex(details.url);
      if (seg) recordSeg(details.tabId, details.url, seg);
      else if (isVideoFileUrl(details.url)) recordMedia(details.tabId, details.url, '', 0);
    });
  },
  { urls: ['<all_urls>'] }
);

// Headers pass: catch extensionless media by Content-Type, and enrich files
// already seen with their real type/size. (Numbered segments are handled above.)
api.webRequest.onHeadersReceived.addListener(
  (details) => {
    ready.then(() => {
      if (isSelf(details)) return;
      if (findSegIndex(details.url)) return; // already recorded as a segment stream
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
      if (mediaMimeKind(mime) === 'file' || isVideoFileUrl(details.url)) {
        recordMedia(details.tabId, details.url, mime, size);
      }
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

api.tabs.onRemoved.addListener((tabId) => resetTab(tabId));

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) { sendResponse({ error: 'unknown_message' }); return; }

    // ----- popup → coordinator: download controls -----
    if (msg.type === 'avd:start') {
      const job = {
        ...msg.job,
        id: 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      };
      await routeCommand({ seq: nextSeq(), action: 'start', job });
      sendResponse({ ok: true, id: job.id });
      return;
    }
    if (msg.type === 'avd:stop') {
      await routeCommand({ seq: nextSeq(), action: 'stop' });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'avd:convert') {
      await routeCommand({ seq: nextSeq(), action: 'convert' });
      sendResponse({ ok: true });
      return;
    }

    // ----- offscreen engine → coordinator (Chrome) -----
    if (msg.type === 'avd:engine:ready') {
      if (pendingCmd) api.runtime.sendMessage({ type: 'avd:engine:cmd', cmd: pendingCmd }).catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'avd:engine:state') {
      publishState(msg.state);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'avd:download') {
      let ok = false;
      try {
        if (api.downloads && api.downloads.download) {
          await api.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false });
          ok = true;
        }
      } catch (e) {
        ok = false;
      }
      sendResponse({ ok });
      return;
    }

    // ----- popup → coordinator: detected streams on a tab -----
    await hydrate();
    if (msg.type === 'getStreams') {
      const tabKey = String(msg.tabId);
      const streams = streamStore[tabKey] || {};
      const mediaList = (mediaStore[tabKey] || []).slice().reverse(); // newest first
      sendResponse({
        streams: Object.keys(streams)
          .filter((key) => streams[key] && typeof streams[key].pre === 'string')
          .map((key) => {
            const v = streams[key];
            return {
              key,
              pre: v.pre,
              post: v.post,
              pad: v.pad || 0,
              min: v.min,
              max: v.max,
              count: v.count,
              ext: v.ext || '',
            };
          }),
        media: mediaList.map((m) => ({ url: m.url, mime: m.mime, size: m.size })),
      });
      return;
    }
    sendResponse({ error: 'unknown_message' });
  })();
  return true; // keep the message channel open for the async sendResponse
});
