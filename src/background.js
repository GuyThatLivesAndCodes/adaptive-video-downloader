// Adaptive Video Downloader — background
//
// 1. Detection: watches network traffic per tab and records every video-ish
//    request so the popup can offer it:
//      • manifests  — HLS (.m3u8) and DASH (.mpd) playlists (best source)
//      • templates  — numbered segment URLs (seg-12, chunk_12, 00012.ts, …)
//                     that differ only by their index, merged into one family
//      • media      — direct progressive files (mp4/webm/mov/…), also caught
//                     by Content-Type when the URL has no extension
//    HLS masters are inspected so their variant/audio playlists (and the
//    segment families those cover) don't show up as duplicate sources.
// 2. Coordinator: routes popup commands to the download engine, which lives in
//    a persistent context — an offscreen document on Chrome, this very page on
//    Firefox — mirrors its progress into storage.session for the popup, saves
//    finished blobs through the Downloads API, keeps the download history, and
//    rewrites Referer/Origin on the engine's own requests when asked.
if (typeof importScripts === 'function' && !globalThis.AVD) importScripts('shared.js');

const api = globalThis.browser ?? globalThis.chrome;
const action = api.action || api.browserAction;
const K = AVD.KEYS;
const SELF_ORIGIN = api.runtime.getURL('').replace(/\/$/, '');
const FIREFOX_ENGINE = !!globalThis.AVD_Engine; // engine is in this page (Firefox)

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|ogv|mkv|ts)(\?|#|$)/i;
const CAPTION_EXT_RE = /\.(vtt|webvtt|srt|ttml|dfxp)(\?|#|$)/i;
const CAPTION_MIME_RE = /^(text\/vtt|application\/x-subrip|text\/srt|application\/ttml\+xml)/i;
// WebVTT pieces of an HLS subtitle playlist, not standalone caption files.
const CAPTION_SEGMENT_RE = /((seg(ment)?|chunk|frag(ment)?|fileSequence|part)[-_]?\d+|\d{3,})\.(web)?vtt$/i;
const MANIFEST_EXT_RE = /\.(m3u8|mpd)(\?|#|$)/i;
const HLS_MIME_RE = /(application|audio)\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i;
const DASH_MIME_RE = /application\/dash\+xml/i;

/* ---------------- settings ---------------- */

let settings = { ...AVD.DEFAULT_SETTINGS };
const settingsReady = api.storage.local
  .get(K.settings)
  .then((d) => {
    settings = { ...AVD.DEFAULT_SETTINGS, ...((d && d[K.settings]) || {}) };
  })
  .catch(() => {});
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[K.settings]) {
    settings = { ...AVD.DEFAULT_SETTINGS, ...(changes[K.settings].newValue || {}) };
    refreshAllBadges();
    syncGuards();
  }
});

/* ---------------- per-tab detection store ---------------- */

let streamStore = {};
let mediaStore = {};
let manifestStore = {};
let captionStore = {};
let hydrated = false;
let hydrating = null;

function hydrate() {
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = api.storage.session
      .get([K.streams, K.media, K.manifests, K.captions])
      .then((d) => {
        streamStore = (d && d[K.streams]) || {};
        mediaStore = (d && d[K.media]) || {};
        manifestStore = (d && d[K.manifests]) || {};
        captionStore = (d && d[K.captions]) || {};
        prune();
        hydrated = true;
      })
      .catch(() => {
        hydrated = true;
      });
  }
  return hydrating;
}

// Drop entries written by older versions (they lack pre/post and would build
// "undefinedN.ts" URLs).
function prune() {
  for (const tab of Object.keys(streamStore)) {
    const streams = streamStore[tab] || {};
    for (const key of Object.keys(streams)) {
      const v = streams[key];
      if (!v || typeof v.pre !== 'string' || typeof v.post !== 'string') delete streams[key];
    }
    if (!Object.keys(streams).length) delete streamStore[tab];
  }
}
const ready = hydrate();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api.storage.session
      .set({ [K.streams]: streamStore, [K.media]: mediaStore, [K.manifests]: manifestStore, [K.captions]: captionStore })
      .catch(() => {});
  }, 300);
}

function isSelf(details) {
  const origin = details.originUrl || details.initiator || details.documentUrl || '';
  return !!(origin && SELF_ORIGIN && origin.startsWith(SELF_ORIGIN));
}

const bare = (u) => String(u || '').split(/[?#]/)[0];
const dirOf = (u) => bare(u).replace(/[^/]*$/, '');

// Segment tokens followed by the index, plus a bare trailing number on
// transport-stream/fMP4 segments (00012.ts, media_1.ts). Tight on purpose so
// directory words (media, part) aren't mistaken for an index.
const SEG_TOKEN_RE = /(seg(?:ment)?|chunk|frag(?:ment)?)[-_]?(\d+)/gi;
const TS_TRAILING_RE = /(\d+)(\.(?:ts|m4s|m4v|m4a|aac))$/i;

// Split a URL around its segment index → { pre, post, n, pad } or null. Only
// the PATH is searched; `post` keeps the query so the signed token rides along.
function findSegIndex(fullUrl) {
  let u;
  try {
    u = new URL(fullUrl);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const path = u.pathname;
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
    if (t) {
      start = t.index;
      len = t[1].length;
    }
  }
  if (start < 0) return null;
  const digits = path.slice(start, start + len);
  return {
    pre: u.origin + path.slice(0, start),
    post: path.slice(start + len) + (u.search || ''),
    n: parseInt(digits, 10),
    pad: digits[0] === '0' ? len : 0,
  };
}

function extOf(url) {
  const m = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(bare(url));
  return m ? m[1].toLowerCase() : '';
}

function recordSeg(tabId, url, seg) {
  const key = seg.pre + '#' + seg.post.split('?')[0];
  const tabKey = String(tabId);
  const streams = (streamStore[tabKey] = streamStore[tabKey] || {});
  const isNew = !streams[key];
  const e =
    streams[key] ||
    (streams[key] = { pre: seg.pre, post: seg.post, pad: seg.pad, min: seg.n, max: seg.n, count: 0, ext: extOf(url), ts: Date.now() });
  e.pre = seg.pre; // freshest token
  e.post = seg.post;
  e.pad = seg.pad;
  e.min = Math.min(e.min, seg.n);
  e.max = Math.max(e.max, seg.n);
  e.count += 1;
  e.ts = Date.now();
  scheduleSave();
  if (isNew) queueBadge(tabId);
}

function recordMedia(tabId, url, mime, size) {
  if (/^(data|blob):/i.test(url)) return;
  if (findSegIndex(url)) return; // numbered segment → handled as a stream
  if (/googlevideo\.com/i.test(url)) return; // YouTube DASH pieces aren't whole files
  if (/\.m4s(\?|#|$)/i.test(url)) return; // DASH fragment
  const tabKey = String(tabId);
  const list = (mediaStore[tabKey] = mediaStore[tabKey] || []);
  const b = bare(url);
  const existing = list.find((x) => bare(x.url) === b);
  if (existing) {
    existing.url = url;
    existing.ts = Date.now();
    if (size && size > (existing.size || 0)) existing.size = size;
    if (mime && !existing.mime) existing.mime = mime;
    scheduleSave();
    return;
  }
  list.push({ url, mime: mime || '', size: size || 0, ts: Date.now() });
  while (list.length > 40) list.shift();
  scheduleSave();
  queueBadge(tabId);
}

function recordManifest(tabId, url, kind) {
  if (/^(data|blob):/i.test(url)) return;
  const tabKey = String(tabId);
  const list = (manifestStore[tabKey] = manifestStore[tabKey] || []);
  const b = bare(url);
  const existing = list.find((x) => bare(x.url) === b);
  if (existing) {
    existing.url = url;
    existing.ts = Date.now();
    scheduleSave();
    return;
  }
  const entry = { url, kind, ts: Date.now(), inspected: false };
  list.push(entry);
  while (list.length > 40) list.shift();
  scheduleSave();
  queueBadge(tabId);
  inspect(tabId, entry);
}

// Peek inside HLS playlists so the popup can fold variant/audio playlists into
// their master and hide segment families a playlist already covers.
async function inspect(tabId, entry) {
  if (entry.kind !== 'hls') {
    // DASH segments are almost always relative to the manifest.
    entry.inspected = true;
    entry.isMaster = true;
    entry.segDirs = [dirOf(entry.url)];
    queueBadge(tabId);
    return;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(entry.url, { credentials: 'include', signal: ctrl.signal });
    const text = res.ok ? await res.text() : '';
    clearTimeout(t);
    if (!/^\s*#EXTM3U/.test(text)) return;
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const abs = (u) => {
      try {
        return new URL(u, res.url || entry.url).href;
      } catch (e) {
        return '';
      }
    };
    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      entry.isMaster = true;
      const kids = new Set();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          let j = i + 1;
          while (j < lines.length && (!lines[j] || lines[j][0] === '#')) j++;
          if (lines[j]) kids.add(bare(abs(lines[j])));
        }
        const m = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):.*URI="([^"]+)"/.exec(lines[i]);
        if (m) kids.add(bare(abs(m[1])));
      }
      entry.children = [...kids];
    } else {
      entry.isMaster = false;
      entry.live = !lines.some((l) => l.startsWith('#EXT-X-ENDLIST') || l === '#EXT-X-PLAYLIST-TYPE:VOD');
      const dirs = new Set();
      for (const l of lines) {
        if (l && l[0] !== '#') dirs.add(dirOf(abs(l)));
        if (dirs.size > 3) break;
      }
      entry.segDirs = [...dirs];
    }
    entry.inspected = true;
    scheduleSave();
    queueBadge(tabId);
  } catch (e) {
    /* leave uninspected — the popup still lists it */
  }
}

function recordCaption(tabId, url, mime) {
  if (!/^https?:/i.test(url) || CAPTION_SEGMENT_RE.test(bare(url))) return;
  const tabKey = String(tabId);
  const list = (captionStore[tabKey] = captionStore[tabKey] || []);
  const b = bare(url);
  const existing = list.find((x) => bare(x.url) === b);
  if (existing) {
    existing.url = url;
    return scheduleSave();
  }
  list.push({ url, mime: mime || '', ts: Date.now() });
  while (list.length > 20) list.shift();
  scheduleSave();
}

function resetTab(tabId) {
  const k = String(tabId);
  let changed = false;
  for (const store of [streamStore, mediaStore, manifestStore, captionStore]) {
    if (store[k]) {
      delete store[k];
      changed = true;
    }
  }
  if (changed) scheduleSave();
  queueBadge(tabId);
}

// The tab's candidates with duplicates folded away.
function candidatesFor(tabId) {
  const k = String(tabId);
  const manifests = manifestStore[k] || [];
  const children = new Set();
  const covered = [];
  for (const m of manifests) {
    (m.children || []).forEach((c) => children.add(c));
    (m.segDirs || []).forEach((d) => covered.push(d));
  }
  const lists = manifests.filter((m) => !children.has(bare(m.url)));
  const streams = Object.entries(streamStore[k] || {})
    .filter(([, v]) => v && typeof v.pre === 'string')
    .map(([key, v]) => ({ key, ...v, covered: covered.some((d) => v.pre.startsWith(d)) }));
  const media = (mediaStore[k] || []).slice().reverse();
  const captions = (captionStore[k] || []).filter((c) => !children.has(bare(c.url)));
  return { manifests: lists, hiddenManifests: manifests.length - lists.length, streams, media, captions };
}

/* ---------------- badge ---------------- */

const badgeTimers = new Map();
function queueBadge(tabId) {
  if (tabId == null || tabId < 0 || badgeTimers.has(tabId)) return;
  badgeTimers.set(
    tabId,
    setTimeout(() => {
      badgeTimers.delete(tabId);
      updateBadge(tabId);
    }, 400)
  );
}

function updateBadge(tabId) {
  if (!action || !action.setBadgeText) return;
  let n = 0;
  if (settings.badge) {
    const c = candidatesFor(tabId);
    n = c.manifests.length + c.streams.filter((s) => !s.covered).length + (c.manifests.length ? 0 : c.media.length);
  }
  try {
    action.setBadgeText({ tabId, text: n ? String(Math.min(n, 99)) : '' });
    action.setBadgeBackgroundColor && action.setBadgeBackgroundColor({ tabId, color: '#0A84FF' });
    action.setBadgeTextColor && action.setBadgeTextColor({ tabId, color: '#FFFFFF' });
  } catch (e) {}
}

function refreshAllBadges() {
  api.tabs.query({}).then((tabs) => tabs.forEach((t) => queueBadge(t.id))).catch(() => {});
}

/* ---------------- network observation ---------------- */

api.webRequest.onBeforeRequest.addListener(
  (details) => {
    ready.then(() => {
      if (details.tabId == null || details.tabId < 0 || isSelf(details)) return;
      if (details.type === 'main_frame') {
        resetTab(details.tabId);
        return;
      }
      const url = details.url;
      if (CAPTION_EXT_RE.test(bare(url) + '?')) return recordCaption(details.tabId, url, '');
      if (MANIFEST_EXT_RE.test(bare(url) + '?')) {
        recordManifest(details.tabId, url, /\.mpd$/i.test(bare(url)) ? 'dash' : 'hls');
        return;
      }
      const seg = findSegIndex(url);
      if (seg) recordSeg(details.tabId, url, seg);
      else if (VIDEO_EXT_RE.test(bare(url) + '?')) recordMedia(details.tabId, url, '', 0);
    });
  },
  { urls: ['<all_urls>'] }
);

// Headers pass: extensionless manifests/media by Content-Type, plus real size.
api.webRequest.onHeadersReceived.addListener(
  (details) => {
    ready.then(() => {
      if (details.tabId == null || details.tabId < 0 || isSelf(details)) return;
      if (details.statusCode && details.statusCode >= 400) return;
      const headers = details.responseHeaders || [];
      let mime = '';
      let size = 0;
      for (const h of headers) {
        const name = h.name.toLowerCase();
        const val = h.value || '';
        if (name === 'content-type') mime = val;
        else if (name === 'content-length') {
          if (!size) size = parseInt(val, 10) || 0;
        } else if (name === 'content-range') {
          const mm = /\/(\d+)\s*$/.exec(val);
          if (mm) size = parseInt(mm[1], 10) || size;
        }
      }
      const url = details.url;
      if (CAPTION_MIME_RE.test(mime)) return recordCaption(details.tabId, url, mime);
      if (HLS_MIME_RE.test(mime)) return recordManifest(details.tabId, url, 'hls');
      if (DASH_MIME_RE.test(mime)) return recordManifest(details.tabId, url, 'dash');
      if (MANIFEST_EXT_RE.test(bare(url) + '?') || findSegIndex(url)) return;
      const isVideoMime = /^video\//i.test(mime.split(';')[0].trim()) && !/mp2t/i.test(mime);
      if (isVideoMime || VIDEO_EXT_RE.test(bare(url) + '?')) recordMedia(details.tabId, url, mime, size);
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

api.tabs.onRemoved.addListener((tabId) => {
  resetTab(tabId);
  if (shields[tabId]) {
    delete shields[tabId];
    saveShields();
  }
});

/* ---------------- pop-up shield & sketchy sites ---------------- */
//
// Video sites love invisible overlays that turn the first click on "play" into
// a pop-under or a redirect. With the shield on for a tab:
//   • any new tab/window it opens to ANOTHER site is closed immediately and
//     focus returns to the video (same-site tabs are left alone);
//   • a jump of the tab itself to another site that the user didn't ask for is
//     undone — for 20 s after "Play safely", or always on a site the user
//     marked as sketchy.
// "Did the user ask?" = typed/bookmarked/reload/back-forward navigations, or a
// cross-site link the in-page guard (guard.js) let through after a confirm.
// On sketchy sites guard.js also neutralises click-traps, ad links and
// window.open from the first byte of every page load.
//
// Pop-ups and redirects are also counted per site even with no shield, so the
// popup can suggest "Mark as sketchy".

const GUARD_MS = 20000;
const ALLOW_MS = 6000;
let shields = {};
let risk = {};
const shieldsReady = api.storage.session
  .get([K.shields, K.risk])
  .then((d) => {
    shields = (d && d[K.shields]) || {};
    risk = (d && d[K.risk]) || {};
  })
  .catch(() => {});
function saveShields() {
  api.storage.session.set({ [K.shields]: shields, [K.risk]: risk }).catch(() => {});
}

const isSketchy = (site) => !!site && (settings.sketchySites || []).includes(site);
const tabSites = new Map(); // tabId → site of the committed top-level page
const allowNav = new Map(); // tabId → { site, until } the user confirmed

function bumpRisk(site, field) {
  if (!site) return;
  const r = (risk[site] = risk[site] || { popups: 0, redirects: 0 });
  r[field]++;
  saveShields();
}

async function setShield(tabId, on, guard) {
  await shieldsReady;
  if (!on) {
    delete shields[tabId];
  } else {
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    const prev = shields[tabId];
    const site = AVD.siteKey(tab.url || '');
    shields[tabId] = {
      site,
      blocked: prev ? prev.blocked : 0,
      guardUntil: guard ? Date.now() + GUARD_MS : prev ? prev.guardUntil : 0,
      sketchy: isSketchy(site),
    };
  }
  saveShields();
  return shields[tabId] || null;
}

function countBlocked(tabId) {
  const sh = shields[tabId];
  if (!sh) return;
  sh.blocked++;
  saveShields();
}

const pendingPopups = new Map(); // new tabId → opener tabId (URL not known yet)

function blockPopup(tabId, openerId) {
  pendingPopups.delete(tabId);
  if (!shields[openerId]) return;
  countBlocked(openerId);
  api.tabs.remove(tabId).catch(() => {});
  api.tabs.update(openerId, { active: true }).catch(() => {});
}

const foregroundPopups = new Set(); // new tabs that opened in front (pop-up style)

function judgePopup(tabId, openerId, url) {
  if (!url || url === 'about:blank') return; // wait for the real destination
  pendingPopups.delete(tabId);
  if (!/^https?:/i.test(url)) return;
  const openerSite = tabSites.get(openerId) || (shields[openerId] && shields[openerId].site);
  const site = AVD.siteKey(url);
  if (!openerSite || site === openerSite) return;
  // Ctrl/middle-click background tabs are the user's own; pop-ups open in front.
  if (foregroundPopups.delete(tabId)) bumpRisk(openerSite, 'popups');
  const allow = allowNav.get(openerId);
  if (allow && allow.site === site && Date.now() < allow.until) return allowNav.delete(openerId); // one confirmed click = one pass
  if (shields[openerId]) blockPopup(tabId, openerId);
}

api.tabs.onCreated.addListener((tab) => {
  shieldsReady.then(() => {
    const opener = tab.openerTabId;
    if (opener == null) return;
    pendingPopups.set(tab.id, opener);
    if (tab.active) foregroundPopups.add(tab.id);
    judgePopup(tab.id, opener, tab.pendingUrl || tab.url);
    if (!shields[opener]) return;
    // Pop-unders that never leave about:blank are closed too.
    setTimeout(() => {
      if (pendingPopups.get(tab.id) !== opener) return;
      api.tabs
        .get(tab.id)
        .then((t) => {
          const u = t.pendingUrl || t.url || '';
          if (!u || u === 'about:blank') blockPopup(tab.id, opener);
          else judgePopup(tab.id, opener, u);
        })
        .catch(() => pendingPopups.delete(tab.id));
    }, 3000);
  });
});

api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && pendingPopups.has(tabId)) shieldsReady.then(() => judgePopup(tabId, pendingPopups.get(tabId), info.url));
});

const USER_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'reload', 'start_page', 'auto_toplevel']);

if (api.webNavigation && api.webNavigation.onCommitted) {
  api.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0 || !/^https?:/i.test(d.url)) return;
    shieldsReady.then(() => {
      const tabId = d.tabId;
      const prev = tabSites.get(tabId) || (shields[tabId] && shields[tabId].site);
      const site = AVD.siteKey(d.url);
      tabSites.set(tabId, site);
      const q = d.transitionQualifiers || [];
      const byUser = USER_TRANSITIONS.has(d.transitionType) || q.includes('forward_back') || q.includes('from_address_bar');
      const allow = allowNav.get(tabId);
      const confirmed = !!(allow && allow.site === site && Date.now() < allow.until);
      if (confirmed) allowNav.delete(tabId); // one confirmed click = one pass
      const allowed = byUser || confirmed;

      if (prev && site !== prev) {
        // Script/meta/server redirects only — a normal link click isn't suspicious.
        if (!byUser && (q.includes('client_redirect') || q.includes('server_redirect'))) bumpRisk(prev, 'redirects');
        const sh = shields[tabId];
        const guarded = sh && (sh.sketchy || Date.now() < sh.guardUntil);
        if (guarded && !allowed) {
          // Hijacked → put the video page back.
          sh.guardUntil = 0;
          countBlocked(tabId);
          tabSites.set(tabId, prev);
          api.tabs.goBack(tabId).catch(() => {});
          return;
        }
        if (sh && sh.site !== site) {
          delete shields[tabId]; // the user went somewhere else
          saveShields();
        }
      }
      if (isSketchy(site) && (!shields[tabId] || !shields[tabId].sketchy)) {
        shields[tabId] = { site, blocked: (shields[tabId] && shields[tabId].blocked) || 0, guardUntil: 0, sketchy: true };
        saveShields();
      }
    });
  });
}

/* sketchy-site guard scripts */

const GUARD_IDS = ['avd-guard', 'avd-guard-main'];
let ffGuard = null;
let guardSig = '';

function matchesFor(sites) {
  return sites.flatMap((s) => (/^[\d.]+$|^localhost$/.test(s) ? [`*://${s}/*`] : [`*://${s}/*`, `*://*.${s}/*`]));
}

async function syncGuards() {
  const sites = (settings.sketchySites || []).filter(Boolean);
  const sig = sites.join('|');
  if (sig === guardSig) return;
  guardSig = sig;
  const matches = matchesFor(sites);
  try {
    if (!FIREFOX_ENGINE && api.scripting && api.scripting.registerContentScripts) {
      const existing = await api.scripting.getRegisteredContentScripts({ ids: GUARD_IDS }).catch(() => []);
      if (existing.length) await api.scripting.unregisterContentScripts({ ids: existing.map((x) => x.id) });
      if (!matches.length) return;
      await api.scripting.registerContentScripts([
        { id: 'avd-guard', matches, js: ['shared.js', 'guard.js'], runAt: 'document_start', allFrames: true },
        { id: 'avd-guard-main', matches, js: ['guard-main.js'], runAt: 'document_start', allFrames: true, world: 'MAIN' },
      ]);
    } else if (api.contentScripts && api.contentScripts.register) {
      if (ffGuard) await ffGuard.unregister().catch(() => {});
      ffGuard = null;
      if (!matches.length) return;
      ffGuard = await api.contentScripts.register({ matches, js: [{ file: 'shared.js' }, { file: 'guard.js' }], runAt: 'document_start', allFrames: true });
    }
  } catch (e) {
    guardSig = ''; // retry on the next change
  }
}

// Protect the page that's open right now, without a reload.
async function injectGuard(tabId) {
  try {
    if (api.scripting && api.scripting.executeScript && !FIREFOX_ENGINE) {
      await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['guard-main.js'], world: 'MAIN' });
      await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['shared.js', 'guard.js'] });
    } else {
      await api.tabs.executeScript(tabId, { file: 'shared.js', allFrames: true });
      await api.tabs.executeScript(tabId, { file: 'guard.js', allFrames: true });
    }
  } catch (e) {}
}

settingsReady.then(syncGuards);

/* ---------------- Referer / Origin for the engine's requests ---------------- */
//
// Many CDNs only serve media to requests that look like they came from the
// page. Chrome: a session DNR rule scoped to this extension's own requests.
// Firefox: a blocking onBeforeSendHeaders listener (also scoped to us).

const HEADER_RULE_ID = 4207;
let ffHeaders = null;

// Two owners can ask for headers: a running job, and the popup while it
// previews streams. The job always wins; the popup's request expires on its own.
const headerOwners = {};
let scanExpiry = null;
function setHeadersFor(owner, h) {
  if (h && h.referer) headerOwners[owner] = h;
  else delete headerOwners[owner];
  if (owner === 'scan') {
    clearTimeout(scanExpiry);
    if (h) scanExpiry = setTimeout(() => setHeadersFor('scan', null), 30000);
  }
  return applyHeaders(headerOwners.job || headerOwners.scan || null);
}

async function applyHeaders(h) {
  let origin = '';
  try {
    origin = h && h.referer ? new URL(h.referer).origin : '';
  } catch (e) {
    origin = '';
  }
  if (api.declarativeNetRequest && api.declarativeNetRequest.updateSessionRules) {
    const addRules =
      h && h.referer
        ? [
            {
              id: HEADER_RULE_ID,
              priority: 1,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [
                  { header: 'referer', operation: 'set', value: h.referer },
                  ...(origin ? [{ header: 'origin', operation: 'set', value: origin }] : []),
                ],
              },
              condition: { initiatorDomains: [api.runtime.id], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
            },
          ]
        : [];
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [HEADER_RULE_ID], addRules });
    return;
  }
  ffHeaders = h && h.referer ? { referer: h.referer, origin } : null;
}

if (FIREFOX_ENGINE && api.webRequest.onBeforeSendHeaders) {
  try {
    api.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        if (!ffHeaders || !isSelf(details) || details.tabId !== -1) return {};
        const headers = (details.requestHeaders || []).filter((h) => !/^(referer|origin)$/i.test(h.name));
        headers.push({ name: 'Referer', value: ffHeaders.referer });
        if (ffHeaders.origin) headers.push({ name: 'Origin', value: ffHeaders.origin });
        return { requestHeaders: headers };
      },
      { urls: ['<all_urls>'] },
      ['blocking', 'requestHeaders']
    );
  } catch (e) {
    /* webRequestBlocking unavailable */
  }
}

/* ---------------- history ---------------- */

let historyChain = Promise.resolve();
function mutateHistory(fn) {
  historyChain = historyChain
    .then(async () => {
      const d = await api.storage.local.get(K.history);
      const list = (d && d[K.history]) || [];
      const next = fn(list) || list;
      await api.storage.local.set({ [K.history]: next.slice(0, settings.historyLimit || 500) });
    })
    .catch(() => {});
  return historyChain;
}

const notifTargets = new Map();
function notifyFinished(rec) {
  if (!settings.notify || !api.notifications || !api.notifications.create) return;
  const title =
    rec.status === 'complete' ? 'Download complete' : rec.status === 'partial' ? 'Saved (partial)' : 'Download failed';
  const msg =
    rec.status === 'failed'
      ? `${rec.title}\n${rec.error || ''}`.trim()
      : `${rec.title}\n${[rec.quality, (rec.format || '').toUpperCase(), AVD.formatBytes(rec.size)].filter(Boolean).join(' · ')}`;
  const id = 'avd_' + rec.id;
  const file = (rec.files || []).find((f) => f.ok && f.id != null);
  if (file) notifTargets.set(id, file.id);
  api.notifications
    .create(id, { type: 'basic', iconUrl: api.runtime.getURL('icons/icon-128.png'), title, message: msg })
    .catch(() => {});
}

if (api.notifications && api.notifications.onClicked) {
  api.notifications.onClicked.addListener((id) => {
    const dl = notifTargets.get(id);
    if (dl != null && api.downloads && api.downloads.show) {
      try {
        api.downloads.show(dl);
      } catch (e) {}
    }
    try {
      api.notifications.clear(id);
    } catch (e) {}
  });
}

function onFinished(rec) {
  mutateHistory((list) => [rec, ...list.filter((r) => r.id !== rec.id)]);
  notifyFinished(rec);
}

/* ---------------- engine coordination ---------------- */

let lastAssignedSeq = 0;
function nextSeq() {
  // Monotonic across service-worker restarts (the engine de-dupes by seq).
  lastAssignedSeq = Math.max(Date.now(), lastAssignedSeq + 1);
  return lastAssignedSeq;
}

let lastTitle = '';
function publishState(state) {
  api.storage.session.set({ [K.state]: state }).catch(() => {});
  // Toolbar tooltip mirrors the running download.
  const a = state && state.active;
  let t = 'Adaptive Video Downloader';
  if (a && (a.phase === 'downloading' || a.phase === 'recording' || a.phase === 'processing')) {
    const pct = a.pct >= 0 ? Math.round(a.pct) + '%' : AVD.formatDuration(a.recorded) || '…';
    t = `${a.phase === 'recording' ? 'Recording' : 'Downloading'} ${pct} — ${a.title}`;
  }
  if (t !== lastTitle && action && action.setTitle) {
    lastTitle = t;
    try {
      action.setTitle({ title: t });
    } catch (e) {}
  }
}

async function saveBlob(url, filename, saveAs) {
  try {
    const id = await api.downloads.download({ url, filename, saveAs: !!saveAs, conflictAction: 'uniquify' });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

if (FIREFOX_ENGINE) {
  const E = globalThis.AVD_Engine;
  E.onState = publishState;
  E.onSave = saveBlob;
  E.onHeaders = (h) => setHeadersFor('job', h);
  E.onFinished = onFinished;
}

let offscreenCreating = null;
async function ensureOffscreen() {
  if (!api.offscreen || !api.offscreen.createDocument) return;
  try {
    if (api.runtime.getContexts) {
      const ctx = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctx && ctx.length) return;
    } else if (api.offscreen.hasDocument && (await api.offscreen.hasDocument())) {
      return;
    }
  } catch (e) {
    /* fall through and try to create */
  }
  if (!offscreenCreating) {
    offscreenCreating = api.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Keep downloading and assembling videos in the background after the popup closes.',
      })
      .catch((e) => {
        if (!/already|single offscreen/i.test(String(e && e.message))) throw e;
      });
  }
  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

// Deliver a command and wait for the engine's ack; a freshly created offscreen
// document may need a moment before its listener is up.
async function routeCommand(cmd) {
  if (FIREFOX_ENGINE) {
    globalThis.AVD_Engine.handleCommand(cmd);
    return true;
  }
  await ensureOffscreen();
  for (let i = 0; i < 40; i++) {
    try {
      const r = await api.runtime.sendMessage({ type: 'avd:engine:cmd', cmd });
      if (r && r.ack) return true;
    } catch (e) {
      /* receiver not ready yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

/* ---------------- context menu ---------------- */

function buildMenus() {
  if (!api.contextMenus) return;
  // Promise style works for both chrome.* (MV3) and Firefox's browser.*.
  Promise.resolve()
    .then(() => api.contextMenus.removeAll())
    .catch(() => {})
    .then(() => {
      api.contextMenus.create({ id: 'avd-media', title: 'Download this video with Adaptive', contexts: ['video', 'audio'] });
      api.contextMenus.create({
        id: 'avd-link',
        title: 'Download linked video with Adaptive',
        contexts: ['link'],
        targetUrlPatterns: ['*://*/*.mp4*', '*://*/*.webm*', '*://*/*.mov*', '*://*/*.m4v*', '*://*/*.m3u8*', '*://*/*.mpd*'],
      });
    })
    .catch(() => {});
}
buildMenus();

if (api.contextMenus && api.contextMenus.onClicked) {
  api.contextMenus.onClicked.addListener(async (info, tab) => {
    const url = info.srcUrl || info.linkUrl || '';
    if (!/^https?:/i.test(url)) {
      // Streamed (blob:/MediaSource) video — the popup knows the real sources.
      try {
        if (action.openPopup) await action.openPopup();
      } catch (e) {}
      return;
    }
    const kind = /\.m3u8(\?|#|$)/i.test(url) ? 'hls' : /\.mpd(\?|#|$)/i.test(url) ? 'dash' : 'file';
    const pageUrl = (tab && tab.url) || info.pageUrl || '';
    const title = AVD.cleanTitle((tab && tab.title) || '', pageUrl) || AVD.siteName(url);
    const job = {
      id: AVD.uid('job'),
      mode: 'auto',
      title,
      filename: AVD.applyTemplate(settings.filenameTemplate, { title, site: AVD.siteName(pageUrl), quality: '' }),
      site: AVD.siteName(pageUrl || url),
      pageUrl,
      favicon: (tab && tab.favIconUrl && tab.favIconUrl.length < 2048 && tab.favIconUrl) || '',
      thumb: '',
      source: { type: kind, url },
      options: { ...settings, referer: settings.sendReferer ? pageUrl : '', range: null },
    };
    await routeCommand({ seq: nextSeq(), action: 'enqueue', job });
  });
}

/* ---------------- messages ---------------- */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || msg.type === 'avd:engine:cmd') return false;
  (async () => {
    switch (msg.type) {
      // popup → engine
      case 'avd:enqueue': {
        const job = { ...msg.job, id: msg.job.id || AVD.uid('job') };
        const ok = await routeCommand({ seq: nextSeq(), action: 'enqueue', job });
        return { ok, id: job.id };
      }
      case 'avd:control':
        return { ok: await routeCommand({ seq: nextSeq(), action: msg.action, id: msg.id }) };

      // engine (offscreen) → coordinator
      case 'avd:engine:state':
        publishState(msg.state);
        return { ok: true };
      case 'avd:engine:save':
        return saveBlob(msg.url, msg.filename, msg.saveAs);
      case 'avd:engine:headers':
        try {
          await setHeadersFor('job', msg.headers);
          return { ok: true };
        } catch (e) {
          return { ok: false };
        }
      case 'avd:engine:finished':
        onFinished(msg.record);
        return { ok: true };

      case 'avd:scanHeaders':
        try {
          await setHeadersFor('scan', msg.referer ? { referer: msg.referer } : null);
        } catch (e) {}
        return { ok: true };

      // popup → detection / history
      case 'avd:candidates':
        await hydrate();
        return candidatesFor(msg.tabId);
      case 'avd:shield':
        return { shield: await setShield(msg.tabId, !!msg.on, !!msg.guard) };
      case 'avd:risk': {
        await shieldsReady;
        return { risk: risk[msg.site] || { popups: 0, redirects: 0 } };
      }
      case 'avd:sketchy': {
        // Mark/unmark the tab's site; protection starts on this page right away.
        await settingsReady;
        const sites = new Set(settings.sketchySites || []);
        if (msg.on) sites.add(msg.site);
        else sites.delete(msg.site);
        settings = { ...settings, sketchySites: [...sites] };
        await api.storage.local.set({ [K.settings]: settings });
        await syncGuards();
        if (msg.on && msg.tabId != null) {
          await injectGuard(msg.tabId);
          tabSites.set(msg.tabId, msg.site);
        }
        if (msg.tabId != null) {
          if (msg.on) await setShield(msg.tabId, true, false);
          else if (shields[msg.tabId]) shields[msg.tabId].sketchy = false;
          saveShields();
        }
        return { ok: true, shield: shields[msg.tabId] || null };
      }
      // in-page guard → coordinator
      case 'avd:guard:blocked':
        if (sender.tab) countBlocked(sender.tab.id);
        return { ok: true };
      case 'avd:guard:allow':
        if (sender.tab) allowNav.set(sender.tab.id, { site: AVD.siteKey(msg.url), until: Date.now() + ALLOW_MS });
        return { ok: true };
      case 'avd:clearTab':
        await hydrate();
        resetTab(msg.tabId);
        return { ok: true };
      case 'avd:history:remove':
        await mutateHistory((list) => list.filter((r) => r.id !== msg.id));
        return { ok: true };
      case 'avd:history:clear':
        await mutateHistory(() => []);
        return { ok: true };
      default:
        return { error: 'unknown_message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true; // async sendResponse
});
