// Adaptive Video Downloader — popup.
//
// Three tabs:
//   Download — Auto (one best guess, one tap) or Manual (pick the source and
//              tune quality, audio, format, range, network behaviour…), plus a
//              live card for the running job and the queue behind it.
//   History  — every finished download, searchable, with open/show/visit.
//   Settings — defaults for both modes, appearance, alerts, data.
// Downloads run in the background engine; this page only sends commands and
// renders the engine snapshot mirrored in storage.session.
const api = globalThis.browser ?? globalThis.chrome;
const K = AVD.KEYS;
const $ = (id) => document.getElementById(id);
const bare = (u) => String(u || '').split(/[?#]/)[0];

const RUNNING = new Set(['resolving', 'downloading', 'recording', 'processing']);
const TYPE_LABEL = { hls: 'HLS stream', dash: 'DASH stream', template: 'Segment stream', file: 'Video file' };
const TYPE_ICON = { hls: 'i-stack', dash: 'i-stack', template: 'i-film', file: 'i-file' };

const state = {
  settings: { ...AVD.DEFAULT_SETTINGS },
  tab: null,
  page: null,
  title: '',
  site: '',
  view: 'download',
  mode: 'auto',
  locked: null,
  scanning: true,
  candidates: [],
  selectedId: null,
  showCovered: false,
  thumb: '',
  thumbPromise: null,
  manual: null,
  engine: null,
  history: [],
  historyFilter: 'all',
  historyQuery: '',
  openHistoryId: null,
  logOpen: new Set(),
  shield: null,
  safeBusy: false,
  safeShown: false,
  pageCaptions: [],
  risk: null,
  riskDismissed: false,
};

/* ---------------- tiny DOM helpers ---------------- */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.appendChild(use);
  return svg;
}

function hue(str) {
  let x = 0;
  for (const ch of String(str || '')) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}

function thumbEl(src, seed, iconName) {
  const t = h('div', { class: 'thumb', style: `--hue:${hue(seed)}` }, icon(iconName || 'i-film'));
  if (src) {
    const img = h('img', { alt: '', src });
    img.onerror = () => img.remove();
    t.append(img);
  }
  return t;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function send(msg) {
  return api.runtime.sendMessage(msg).catch(() => null);
}

// Two-tap confirmation for destructive buttons.
function confirmTap(btn, label, fn) {
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    fn();
    return;
  }
  const original = [...btn.childNodes].map((n) => n.cloneNode(true));
  btn.dataset.armed = '1';
  const span = btn.querySelector('.row-title') || btn.querySelector('span:last-child');
  if (span) span.textContent = label;
  else btn.textContent = label;
  setTimeout(() => {
    if (!btn.dataset.armed) return;
    delete btn.dataset.armed;
    btn.replaceChildren(...original);
  }, 3000);
}

/* ---------------- controls ---------------- */

function segmented(el, value, onChange) {
  const btns = [...el.querySelectorAll('button')];
  el.style.setProperty('--n', btns.length);
  const set = (v, fire) => {
    const i = Math.max(0, btns.findIndex((b) => b.dataset.value === v));
    el.style.setProperty('--i', i);
    btns.forEach((b, j) => {
      b.classList.toggle('on', j === i);
      b.setAttribute('aria-selected', j === i ? 'true' : 'false');
    });
    el.dataset.value = btns[i].dataset.value;
    if (fire && onChange) onChange(btns[i].dataset.value);
  };
  btns.forEach((b) => b.addEventListener('click', () => set(b.dataset.value, true)));
  set(value, false);
  return { set: (v) => set(v, false) };
}

function stepper(el, value, onChange) {
  const min = parseFloat(el.dataset.min || '0');
  const max = parseFloat(el.dataset.max || '100');
  const step = parseFloat(el.dataset.step || '1');
  const unit = el.dataset.unit || '';
  const zero = el.dataset.zero || '';
  const dec = h('button', { type: 'button', 'aria-label': 'Decrease', text: '−' });
  const out = h('output');
  const inc = h('button', { type: 'button', 'aria-label': 'Increase', text: '+' });
  el.replaceChildren(dec, out, inc);
  let v = value;
  const set = (nv, fire) => {
    v = Math.max(min, Math.min(max, nv));
    out.textContent = v === 0 && zero ? zero : v + unit;
    dec.disabled = v <= min;
    inc.disabled = v >= max;
    if (fire && onChange) onChange(v);
  };
  dec.addEventListener('click', () => set(v - step, true));
  inc.addEventListener('click', () => set(v + step, true));
  set(value, false);
  return { set: (nv) => set(nv, false) };
}

function slider(el, valEl, value, onChange) {
  const paint = () => {
    const p = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--p', p + '%');
    valEl.textContent = el.value;
  };
  el.value = value;
  paint();
  el.addEventListener('input', () => {
    paint();
    onChange(parseInt(el.value, 10));
  });
  return {
    set: (v) => {
      el.value = v;
      paint();
    },
  };
}

/* ---------------- settings & appearance ---------------- */

async function loadSettings() {
  try {
    const d = await api.storage.local.get(K.settings);
    state.settings = { ...AVD.DEFAULT_SETTINGS, ...((d && d[K.settings]) || {}) };
  } catch (e) {
    state.settings = { ...AVD.DEFAULT_SETTINGS };
  }
}

let settingsTimer = null;
function saveSettings(patch) {
  Object.assign(state.settings, patch);
  applyAppearance();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => api.storage.local.set({ [K.settings]: state.settings }).catch(() => {}), 200);
}

function applyAppearance() {
  const root = document.documentElement;
  const s = state.settings;
  if (s.theme === 'light' || s.theme === 'dark') root.dataset.theme = s.theme;
  else delete root.dataset.theme;
  root.dataset.accent = s.accent || 'blue';
}

function initManual() {
  const s = state.settings;
  state.manual = {
    variantKey: null,
    audioKey: null,
    format: s.format,
    keepOriginal: s.keepOriginal,
    filename: '',
    filenameEdited: false,
    whole: true,
    from: '',
    to: '',
    live: true,
    liveMax: 0,
    adaptive: !s.concurrency,
    conc: s.concurrency || 8,
    retries: s.retries,
    timeout: s.timeout,
    delay: s.delayMs || 0,
    onMissing: s.onMissing,
    cookies: s.sendCookies,
    referer: s.sendReferer && state.tab ? state.tab.url || '' : '',
    capOff: new Set(),
    capFormat: s.captionFormat,
    capEmbed: s.captionEmbed,
  };
}

/* ---------------- page probe & thumbnail ---------------- */

// Runs inside every frame of the page: visible <video> elements and metadata.
function avdPageProbe() {
  const vids = [];
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    vids.push({
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      poster: v.poster || '',
      duration: isFinite(v.duration) ? v.duration : 0,
      src: v.currentSrc || v.src || '',
      playing: !v.paused,
    });
  }
  // The page's own resource log catches media requested before the extension
  // was listening (installed/updated mid-session, restored tabs, …).
  let names = [];
  try {
    names = performance.getEntriesByType('resource').map((e) => e.name);
  } catch (e) {}
  const uniq = (a) => [...new Set(a)];
  const manifests = uniq(names.filter((u) => /\.(m3u8|mpd)(\?|#|$)/i.test(u))).slice(-30);
  const files = uniq(names.filter((u) => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(u))).slice(-20);
  const meta = (p) => {
    const m = document.querySelector(`meta[property="${p}"],meta[name="${p}"]`);
    return (m && m.content) || '';
  };
  const abs = (u) => {
    try {
      return u ? new URL(u, location.href).href : '';
    } catch (e) {
      return '';
    }
  };
  // A play button = a player's play overlay, or a paused native player showing
  // its own controls.
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  };
  const playButton =
    [
      ...document.querySelectorAll(
        '.vjs-big-play-button,.jw-display-icon-container,.plyr__control--overlaid,.fp-play,.mejs__overlay-button,.ytp-large-play-button,[class*="play-button" i],[class*="playbutton" i],[class*="btn-play" i],[class*="play-btn" i],button[aria-label*="play" i],[role="button"][aria-label*="play" i]'
      ),
    ].some(visible) || [...document.querySelectorAll('video')].some((v) => v.paused && v.controls && visible(v));

  // Captions: <track> files, cues a player built in memory, caption files the
  // page fetched, and caption URLs sitting in inline player configs.
  const captions = [];
  for (const t of document.querySelectorAll('video track[src], audio track[src]')) {
    if (/^(subtitles|captions)$/i.test(t.kind || 'subtitles')) captions.push({ kind: 'file', url: abs(t.getAttribute('src')), lang: t.srclang || '', label: t.label || '' });
  }
  const ts = (x) => new Date(Math.max(0, x) * 1000).toISOString().slice(11, 23);
  for (const v of document.querySelectorAll('video')) {
    for (const tt of v.textTracks || []) {
      if (!/^(subtitles|captions)$/.test(tt.kind) || !tt.cues || tt.cues.length < 3) continue;
      if ([...v.querySelectorAll('track')].some((t) => t.track === tt && t.src)) continue;
      let text = 'WEBVTT\n\n';
      for (const c of [...tt.cues].slice(0, 8000)) if (c.text) text += `${ts(c.startTime)} --> ${ts(c.endTime)}\n${c.text}\n\n`;
      captions.push({ kind: 'text', text, lang: tt.language || '', label: tt.label || '', fromPlayer: true, count: tt.cues.length });
    }
  }
  for (const u of uniq(names.filter((u) => /\.(vtt|webvtt|srt|ttml|dfxp)(\?|#|$)/i.test(u))).slice(-15)) captions.push({ kind: 'file', url: u });
  let inline = 0;
  for (const sc of document.querySelectorAll('script:not([src])')) {
    const t = sc.textContent || '';
    if (t.length > 3e6 || !/\.(vtt|srt)/i.test(t)) continue;
    for (const m of t.matchAll(/https?:(?:\\?\/){2}[^"'\s<>]+?\.(?:vtt|srt)(?:\?[^"'\s<>]*)?(?=["'\s<>]|$)/gi)) {
      if (inline++ > 15) break;
      captions.push({ kind: 'file', url: m[0].replace(/\\\//g, '/') });
    }
  }

  // Risk signals for "Mark as sketchy": pop-under ad networks, and invisible
  // layers stacked over the page (click-traps).
  const AD = /(popads|popcash|propellerads|propellerclick|adsterra|exoclick|exosrv|juicyads|hilltopads|onclickads|onclkds|adcash|clickadu|trafficstars|tsyndicate|realsrv|admaven|ad-maven|monetag|galaksion|popmyads|bidvertiser|zeropark|pushground|richpush|clickaine|profitableratecpm|highperformanceformat)/i;
  const hostOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  };
  const adNets = uniq([...[...document.scripts].map((x) => x.src), ...names].filter((u) => u && AD.test(u)).map(hostOf).filter(Boolean)).slice(0, 6);
  let traps = 0;
  const seen = new Set();
  for (const fx of [0.25, 0.5, 0.75]) {
    for (const fy of [0.3, 0.6]) {
      for (const el of document.elementsFromPoint(innerWidth * fx, innerHeight * fy)) {
        if (el.tagName === 'VIDEO' || el === document.body || el === document.documentElement) break;
        if (seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const r = el.getBoundingClientRect();
        if ((r.width * r.height) / (innerWidth * innerHeight) < 0.25) continue;
        let player = !!el.querySelector('video');
        for (let n = el.parentElement, i = 0; !player && n && n !== document.body && i < 4; n = n.parentElement, i++) player = !!n.querySelector('video');
        if (player) continue;
        const empty = !(el.innerText || '').trim() && !el.querySelector('img,svg,canvas,video,input,button');
        if (parseFloat(cs.opacity) < 0.1 || (empty && /rgba\(.*,\s*0(\.0\d*)?\)|transparent/.test(cs.backgroundColor) && cs.backgroundImage === 'none')) traps++;
      }
    }
  }

  return {
    top: window === window.top,
    vids,
    needsPlay: playButton,
    captions,
    adNets,
    traps,
    iw: innerWidth,
    ih: innerHeight,
    ogTitle: meta('og:title') || meta('twitter:title'),
    ogImage: abs(meta('og:image') || meta('twitter:image')),
    manifests,
    files,
  };
}

async function probePage() {
  const tab = state.tab;
  if (!tab || !/^(https?|file):/i.test(tab.url || '')) return null;
  const run = async () => {
    if (api.scripting && api.scripting.executeScript) {
      const r = await api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: avdPageProbe });
      return (r || []).map((x) => x && x.result).filter(Boolean);
    }
    if (api.tabs.executeScript) {
      return ((await api.tabs.executeScript(tab.id, { code: '(' + avdPageProbe + ')()', allFrames: true })) || []).filter(Boolean);
    }
    return [];
  };
  let frames = [];
  try {
    frames = await Promise.race([run(), new Promise((res) => setTimeout(() => res([]), 1500))]);
  } catch (e) {
    return null;
  }
  if (!frames.length) return null;
  const top = frames.find((f) => f.top) || frames[0];
  const all = [];
  for (const f of frames) for (const v of f.vids) all.push({ ...v, top: f.top });
  all.sort((a, b) => (b.playing - a.playing) || b.w * b.h - a.w * a.h);
  const video = all[0] || null;
  return {
    ogTitle: top.ogTitle,
    ogImage: top.ogImage,
    iw: top.iw,
    ih: top.ih,
    video,
    duration: video ? video.duration : 0,
    needsPlay: frames.some((f) => f.needsPlay) && !all.some((v) => v.playing),
    captions: frames.flatMap((f) => f.captions || []),
    adNets: [...new Set(frames.flatMap((f) => f.adNets || []))],
    traps: frames.reduce((n, f) => n + (f.traps || 0), 0),
    srcs: all.map((v) => v.src).filter((s) => /^https?:/i.test(s)),
    manifests: frames.flatMap((f) => f.manifests || []),
    files: frames.flatMap((f) => f.files || []),
  };
}

// Runs in every frame, in the page's own JS world. Starts playback WITHOUT a
// real click on the page, so click-jacking overlays and "first click opens an
// ad" scripts never fire:
//   1. silence window.open for a while (pop-ups need it, players don't);
//   2. disable invisible layers stacked on top of the player;
//   3. ask the player library to play (JW Player, video.js, Flowplayer…);
//   4. call play() on the <video> itself (muted if autoplay rules insist);
//   5. last resort: a NON-bubbling click on the player's own play button, which
//      reaches the button's handler but not the document-level ad listeners.
async function avdSafePlay() {
  const W = window.wrappedJSObject || window; // Firefox isolated-world fallback
  const out = { top: window === window.top, started: false, muted: false, method: '', unmasked: 0, popups: 0, videos: 0 };
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 ? r.width * r.height : 0;
  };

  try {
    if (!W.__avdSafe) {
      W.__avdSafe = true;
      const original = W.open;
      const blocked = function () {
        out.popups++;
        return null;
      };
      W.open = typeof exportFunction === 'function' && window.wrappedJSObject ? exportFunction(blocked, window) : blocked;
      setTimeout(() => {
        try {
          W.open = original;
          W.__avdSafe = false;
        } catch (e) {}
      }, 30000);
    }
  } catch (e) {}

  const vids = [...document.querySelectorAll('video')].sort((a, b) => area(b) - area(a));
  out.videos = vids.length;
  let target = vids.find((v) => area(v) > 0) || null;
  if (!target && window === window.top) {
    // Player inside an iframe: guard the iframe's box instead.
    target = [...document.querySelectorAll('iframe')].filter((f) => area(f) > 200 * 110).sort((a, b) => area(b) - area(a))[0] || null;
  }

  // Player container = the outermost ancestor that is still about the video's size.
  let box = target;
  if (target) {
    const ta = area(target);
    for (let el = target.parentElement, i = 0; el && el !== document.body && i < 6; el = el.parentElement, i++) {
      if (area(el) <= ta * 1.6) box = el;
      else break;
    }
    const r = target.getBoundingClientRect();
    const pts = [
      [0.5, 0.5],
      [0.25, 0.3],
      [0.75, 0.7],
    ];
    const seen = new Set();
    for (const [fx, fy] of pts) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === target || box.contains(el) || el.contains(box)) break;
        if (seen.has(el) || el === document.documentElement || el === document.body) continue;
        seen.add(el);
        el.style.setProperty('pointer-events', 'none', 'important');
        if (el.tagName === 'IFRAME' || parseFloat(getComputedStyle(el).opacity) < 0.15) el.style.setProperty('visibility', 'hidden', 'important');
        out.unmasked++;
      }
    }
  }

  // Re-query each time: lazy players create their <video> only once started.
  const allVids = () => [...document.querySelectorAll('video')];
  const playing = () => allVids().some((v) => !v.paused && !v.ended && v.readyState > 1);
  const hasSource = (v) => !!(v.currentSrc || v.src || v.srcObject || v.querySelector('source[src]'));
  // play() on a video with nothing loaded can stay pending forever: cap it.
  // Retry muted only when the browser's autoplay policy refused it.
  const tryPlay = async (v) => {
    const attempt = () => Promise.race([v.play(), new Promise((res) => setTimeout(() => res('pending'), 1500))]);
    try {
      await attempt();
    } catch (e) {
      if (!e || e.name !== 'NotAllowedError') return;
      try {
        v.muted = true;
        await attempt();
        out.muted = true;
      } catch (e2) {}
    }
  };
  const waitPlaying = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (playing()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return playing();
  };

  // Player libraries know how to load their own source.
  const libs = [
    ['JW Player', () => typeof W.jwplayer === 'function', () => W.jwplayer().play()],
    ['video.js', () => W.videojs && W.videojs.getPlayers, () => Object.values(W.videojs.getPlayers()).forEach((p) => p && p.play && p.play())],
    ['Flowplayer', () => typeof W.flowplayer === 'function', () => W.flowplayer().play()],
    ['Clappr', () => W.player && W.player.core && W.player.play, () => W.player.play()],
  ];
  for (const [name, has, play] of libs) {
    try {
      if (!has()) continue;
      play();
      if (await waitPlaying(1200)) {
        out.method = name;
        break;
      }
    } catch (e) {}
  }

  if (!playing()) {
    for (const v of vids) {
      if (!v.paused || !hasSource(v)) continue;
      await tryPlay(v);
      if (playing()) {
        out.method = out.method || 'video';
        break;
      }
    }
  }

  if (!playing()) {
    const scope = box && box !== target ? box : document;
    const btn = [
      ...scope.querySelectorAll(
        '.vjs-big-play-button,.jw-display-icon-container,.jw-icon-display,.plyr__control--overlaid,.fp-play,.mejs__overlay-button,.ytp-large-play-button,[class*="play-button" i],[class*="playbutton" i],[class*="btn-play" i],button[aria-label*="play" i],[role="button"][aria-label*="play" i]'
      ),
    ]
      .filter((el) => area(el) > 0)
      .sort((a, b) => area(b) - area(a))[0];
    if (btn) {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ev = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        btn.dispatchEvent(new Ev(type, { bubbles: false, cancelable: true, view: window }));
      }
      out.method = out.method || 'button';
      // The button's own play() can be refused without a real gesture; retry muted.
      await new Promise((r) => setTimeout(r, 700));
      for (const v of allVids()) if (v.paused && hasSource(v)) await tryPlay(v);
    }
  }

  out.started = await waitPlaying(2500);
  out.muted = out.muted || allVids().some((v) => !v.paused && v.muted);
  return out;
}

async function runSafePlay(tabId) {
  const exec = async (world) => {
    if (api.scripting && api.scripting.executeScript) {
      const r = await api.scripting.executeScript({ target: { tabId, allFrames: true }, func: avdSafePlay, ...(world ? { world } : {}) });
      return (r || []).map((x) => x && x.result).filter(Boolean);
    }
    return ((await api.tabs.executeScript(tabId, { code: '(' + avdSafePlay + ')()', allFrames: true })) || []).filter(Boolean);
  };
  let frames;
  try {
    frames = await exec('MAIN');
  } catch (e) {
    frames = await exec(null); // e.g. older Firefox without world: MAIN
  }
  return {
    started: frames.some((f) => f.started),
    muted: frames.some((f) => f.started && f.muted),
    unmasked: frames.reduce((n, f) => n + f.unmasked, 0),
    popups: frames.reduce((n, f) => n + f.popups, 0),
    videos: frames.reduce((n, f) => n + f.videos, 0),
  };
}

async function safePlay(btn) {
  if (!state.tab || state.safeBusy) return;
  state.safeBusy = true;
  const el = $('safeStatus');
  const say = (cls, text) => {
    el.hidden = false;
    statusLine(el, cls, text);
  };
  if (btn) btn.disabled = true;
  try {
    state.safeShown = true;
    say('busy', 'Starting the video for you…');
    if (state.settings.shieldWithSafePlay) await setShield(true, true);
    let r;
    try {
      r = await Promise.race([runSafePlay(state.tab.id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))]);
    } catch (e) {
      say('err', 'This page can’t be controlled by extensions. Click play yourself — the shield still blocks pop-ups.');
      return;
    }
    const extra = [r.unmasked ? `${r.unmasked} hidden click-trap${r.unmasked === 1 ? '' : 's'} removed` : '', r.popups ? `${r.popups} pop-up${r.popups === 1 ? '' : 's'} stopped` : '']
      .filter(Boolean)
      .join(' · ');
    if (r.started) {
      say('ok', `Playing${r.muted ? ' (muted — unmute on the page)' : ''}. Looking for the stream…` + (extra ? ` ${extra}.` : ''));
      await new Promise((res) => setTimeout(res, 2500));
      state.thumbPromise = null;
      state.thumb = '';
      await scan();
      say('ok', state.candidates.length ? 'Video found — ready to download.' : 'Playing, but no downloadable stream showed up yet. Give it a few seconds and rescan.');
    } else {
      say(
        'warn',
        (r.videos ? 'Couldn’t start it automatically.' : 'No player found to start.') +
          ' Click play on the page' +
          (shieldOn() ? ' — pop-ups to other sites will be closed.' : '.') +
          (extra ? ` (${extra})` : '')
      );
    }
  } finally {
    state.safeBusy = false;
    if (btn) btn.disabled = false;
  }
}

/* ---------------- pop-up shield ---------------- */

function shieldOn() {
  return !!state.shield;
}

async function setShield(on, guard) {
  if (!state.tab) return;
  const r = await send({ type: 'avd:shield', tabId: state.tab.id, on, guard });
  state.shield = (r && r.shield) || null;
  renderShield();
}

function renderShield() {
  const sh = state.shield;
  $('shieldToggle').checked = !!sh;
  $('shieldToggle').closest('.safe-row').hidden = isSketchy(); // always on there
  const n = sh ? sh.blocked : 0;
  $('shieldCount').textContent = sh ? (n ? `${n} blocked` : 'On') : '';
  $('shieldChip').hidden = !sh || state.view !== 'download';
  $('shieldChipText').textContent = (isSketchy() ? 'Protected' : 'Shield on') + (n ? ` · ${n}` : '');
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function drawCover(img, sx, sy, sw, sh, W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const target = W / H;
  if (sw / sh > target) {
    const nw = sh * target;
    sx += (sw - nw) / 2;
    sw = nw;
  } else {
    const nh = sw / target;
    sy += (sh - nh) / 2;
    sh = nh;
  }
  g.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  return c;
}

function mostlyBlack(canvas) {
  const s = document.createElement('canvas');
  s.width = 16;
  s.height = 9;
  const g = s.getContext('2d');
  g.drawImage(canvas, 0, 0, 16, 9);
  const d = g.getImageData(0, 0, 16, 9).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  return sum / (d.length / 4) / 3 < 14;
}

// A small 16:9 still: the visible video frame, else its poster / og:image.
async function makeThumb() {
  const p = state.page;
  const tab = state.tab;
  if (!p || !tab) return '';
  const v = p.video;
  if (v && v.top && v.w > 80 && v.h > 45 && api.tabs.captureVisibleTab) {
    try {
      const shot = await api.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
      const img = await loadImage(shot);
      const scale = img.naturalWidth / (p.iw || img.naturalWidth);
      const x0 = Math.max(0, v.x);
      const y0 = Math.max(0, v.y);
      const x1 = Math.min(p.iw, v.x + v.w);
      const y1 = Math.min(p.ih, v.y + v.h);
      if (x1 - x0 > 60 && y1 - y0 > 34) {
        const c = drawCover(img, x0 * scale, y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale, 320, 180);
        if (!mostlyBlack(c)) return c.toDataURL('image/jpeg', 0.74);
      }
    } catch (e) {
      /* fall through to the poster */
    }
  }
  for (const url of [v && v.poster, p.ogImage]) {
    if (!url || !/^https?:/i.test(url)) continue;
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) continue;
      const bmp = await createImageBitmap(await res.blob());
      return drawCover(bmp, 0, 0, bmp.width, bmp.height, 320, 180).toDataURL('image/jpeg', 0.74);
    } catch (e) {
      /* try the next one */
    }
  }
  return '';
}

function ensureThumb() {
  if (!state.thumbPromise) {
    state.thumbPromise = makeThumb()
      .catch(() => '')
      .then((t) => {
        state.thumb = t;
        renderDownload();
        return t;
      });
  }
  return state.thumbPromise;
}

/* ---------------- candidates ---------------- */

function buildCandidates(resp, page) {
  const out = [];
  for (const m of (resp && resp.manifests) || []) {
    out.push({
      id: 'm:' + bare(m.url),
      type: m.kind,
      url: m.url,
      ts: m.ts || 0,
      status: 'loading',
      live: !!m.live,
      variants: [],
      audios: [],
      duration: 0,
    });
  }
  const known = new Set(out.map((c) => c.id));
  for (const url of (page && page.manifests) || []) {
    const id = 'm:' + bare(url);
    if (known.has(id) || !/^https?:/i.test(url)) continue;
    known.add(id);
    out.push({ id, type: AVD_Manifest.kindOf(url), url, ts: 0, status: 'loading', live: false, variants: [], audios: [], duration: 0 });
  }
  for (const s of (resp && resp.streams) || []) {
    out.push({ id: 't:' + s.key, type: 'template', ts: s.ts || 0, status: 'ready', tpl: s, covered: !!s.covered, variants: [], audios: [] });
  }
  const seen = new Set();
  const media = ((resp && resp.media) || []).slice();
  for (const src of [...((page && page.srcs) || []), ...((page && page.files) || [])]) {
    if (/^https?:/i.test(src)) media.push({ url: src, mime: '', size: 0, ts: 0, fromPage: true });
  }
  for (const f of media) {
    const b = bare(f.url);
    if (seen.has(b)) continue;
    seen.add(b);
    out.push({ id: 'f:' + b, type: 'file', url: f.url, size: f.size || 0, mime: f.mime || '', ts: f.ts || 0, status: 'ready', variants: [], audios: [] });
  }
  return out;
}

function bestVariant(c) {
  return c.variants.find((v) => !v.audioOnly) || c.variants[0] || null;
}

function sizeEstimate(c, variant, audio) {
  if (c.type === 'file') return c.size || 0;
  const d = c.duration || (state.page && state.page.duration) || 0;
  const v = variant || bestVariant(c);
  if (!d || !v || !v.bandwidth) return 0;
  const a = audio || c.audios[0];
  return ((v.bandwidth + (c.type === 'dash' && a && a.bandwidth ? a.bandwidth : 0)) * d) / 8;
}

function score(c) {
  if (c.drm) return -1000;
  let s = { hls: c.isMaster ? 100 : 85, dash: 95, template: 60, file: 50 }[c.type] || 0;
  if (c.status === 'error') s -= 120;
  const pd = state.page && state.page.duration;
  if (c.duration) {
    s += Math.min(c.duration / 60, 20);
    if (pd && Math.abs(c.duration - pd) < Math.max(3, pd * 0.03)) s += 40;
    if (c.duration < 20 && !c.live) s -= 25; // ads, previews
  }
  if (c.type === 'template') s += Math.min(c.tpl.count, 40) / 4 - (c.covered ? 50 : 0);
  if (c.type === 'file') {
    if (c.size > 2 * 1048576) s += 10;
    if (c.size && c.size < 300 * 1024) s -= 30;
  }
  if (c.verify === 'fail') s -= 40;
  if (c.userAdded) s += 200;
  const ts = state.candidates.map((x) => x.ts || 0);
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  if (hi > lo) s += ((c.ts - lo) / (hi - lo)) * 12; // newer wins ties
  return s;
}

function ranked() {
  return state.candidates
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

function pickBest() {
  return ranked()[0] || null;
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    let name = decodeURIComponent(parts[parts.length - 1] || '');
    if (!/\.[a-z0-9]{2,4}$/i.test(name) || /^(index|master|playlist|manifest|video|chunklist)[^/]*\.(m3u8|mpd)$/i.test(name)) {
      name = decodeURIComponent(parts[parts.length - 2] || '') || u.hostname;
    }
    return name.length > 42 ? name.slice(0, 40) + '…' : name;
  } catch (e) {
    return 'video';
  }
}

function candName(c) {
  if (c.type === 'template') return nameFromUrl(c.tpl.pre + '#' + c.tpl.post.split('?')[0]);
  return nameFromUrl(c.url);
}

function candHost(c) {
  return AVD.siteName(c.type === 'template' ? c.tpl.pre : c.url);
}

function candSub(c) {
  const bits = [];
  if (c.type === 'template') {
    bits.push(`#${c.tpl.min}–#${c.tpl.max}`, `${c.tpl.count} seen`);
    if (c.tpl.ext) bits.push('.' + c.tpl.ext);
  } else if (c.type === 'file') {
    const ext = (/\.([a-z0-9]{2,4})$/i.exec(bare(c.url)) || [])[1];
    bits.push((ext || (c.mime.split('/')[1] || 'video')).toUpperCase());
    if (c.size) bits.push(AVD.formatBytes(c.size));
  } else {
    if (c.status === 'loading') bits.push('Checking…');
    else if (c.status === 'error') bits.push('Unreadable: ' + (c.error || 'error'));
    else {
      const qs = c.variants.filter((v) => !v.audioOnly);
      if (qs.length > 1) bits.push(`${qs.length} qualities`);
      else if (qs[0] && AVD.qualityLabel(qs[0])) bits.push(AVD.qualityLabel(qs[0]));
      if (c.duration) bits.push(AVD.formatDuration(c.duration));
      if (c.audios.length > 1) bits.push(`${c.audios.length} audio`);
      if (c.encrypted) bits.push('AES-128');
    }
  }
  bits.push(candHost(c));
  return bits.join(' · ');
}

async function describe(c) {
  try {
    const d = await Promise.race([
      AVD_Manifest.describe(c.url, { timeout: 10 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 12000)),
    ]);
    Object.assign(c, {
      status: 'ready',
      type: d.type,
      isMaster: d.isMaster,
      drm: d.drm,
      encrypted: d.encrypted,
      live: d.live,
      duration: d.duration,
      segCount: d.segCount,
      variants: d.variants,
      audios: d.audios,
      childUrls: d.childUrls || [],
      captions: (d.captions || []).map(normCaption),
    });
  } catch (e) {
    c.status = 'error';
    c.error = (e && e.message) || 'error';
  }
}

/* ---------------- captions ---------------- */

function normCaption(c) {
  const lang = c.lang || AVD_Captions.guessLang(c.label, c.url);
  return {
    ...c,
    id: c.kind === 'text' ? 'c:t:' + lang + ':' + (c.label || '') + ':' + (c.count || 0) : 'c:' + bare(c.url),
    lang,
    status: c.kind === 'file' ? 'checking' : 'ready',
  };
}

// Page-level captions (tracks, fetched files, inline configs) apply to every
// source; a manifest's own subtitle renditions only to that manifest. Cues a
// player built in memory may be incomplete, so they only fill missing languages.
function captionsFor(c) {
  const out = [];
  const seen = new Set();
  for (const x of [...((c && c.captions) || []), ...state.pageCaptions]) {
    if (seen.has(x.id) || x.status === 'bad') continue;
    seen.add(x.id);
    out.push(x);
  }
  return out.filter((x) => !x.fromPlayer || !out.some((y) => y !== x && !y.fromPlayer && y.lang === x.lang));
}

// Fetch each caption file once: count its lines, and drop look-alikes (HLS
// subtitle segments, empty or broken files).
async function checkCaption(cap) {
  try {
    const { text } = await AVD_Manifest.fetchText(cap.url, { timeout: 8 });
    const parsed = AVD_Captions.parseAny(text);
    const end = parsed.cues.length ? parsed.cues[parsed.cues.length - 1].end : 0;
    if (!parsed.cues.length || (parsed.map && end - parsed.cues[0].start < 60)) cap.status = 'bad';
    else {
      cap.status = 'ready';
      cap.count = parsed.cues.length;
      cap.end = end;
    }
  } catch (e) {
    cap.status = 'bad';
  }
}

function captionName(cap) {
  return AVD_Captions.labelOf(cap) + (cap.fromPlayer ? ' (from player)' : '');
}

function captionSub(cap) {
  const where = cap.kind === 'hls' ? 'Stream subtitles' : cap.fromPlayer ? 'Loaded by the player — may be partial' : cap.kind === 'text' ? 'From the page' : 'Caption file';
  const lang = cap.lang ? AVD_Captions.langName(cap.lang) : '';
  return [cap.label && lang !== cap.label ? lang : '', cap.count ? cap.count + ' lines' : '', where].filter(Boolean).join(' · ');
}

function captionSource(cap) {
  return { kind: cap.kind, url: cap.url, text: cap.text, lang: cap.lang, label: cap.label };
}

// Save captions straight away, no video needed.
async function saveCaptionsNow(caps, btn) {
  if (!caps.length) return;
  const fmt = state.mode === 'manual' ? state.manual.capFormat : state.settings.captionFormat;
  const base = AVD.sanitizeFilename(state.title || 'captions');
  const folder = AVD.sanitizeFolder(state.settings.subfolder);
  if (btn) btn.disabled = true;
  let ok = 0;
  try {
    for (const [i, cap] of caps.entries()) {
      try {
        const r = await AVD_Captions.render(captionSource(cap), fmt, { timeout: 15 });
        const tag = cap.lang || (caps.length > 1 ? 'track' + (i + 1) : '');
        const url = URL.createObjectURL(new Blob([r.text], { type: fmt === 'vtt' ? 'text/vtt' : 'application/x-subrip' }));
        await api.downloads.download({ url, filename: (folder ? folder + '/' : '') + base + (tag ? '.' + tag : '') + '.' + r.ext, conflictAction: 'uniquify', saveAs: false });
        ok++;
      } catch (e) {}
    }
  } finally {
    if (btn) btn.disabled = false;
  }
  toast(ok ? `Saved ${ok} caption file${ok === 1 ? '' : 's'} (.${fmt})` : 'Couldn’t download those captions');
}

/* ---------------- sketchy sites ---------------- */

function isSketchy() {
  return (state.settings.sketchySites || []).includes(AVD.siteKey((state.tab && state.tab.url) || ''));
}

function riskInfo() {
  const p = state.page || {};
  const r = state.risk || {};
  const blocked = (state.shield && state.shield.blocked) || 0;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const reasons = [];
  if (r.popups) reasons.push(plural(r.popups, 'pop-up'));
  if (r.redirects) reasons.push(plural(r.redirects, 'redirect'));
  if (p.traps) reasons.push(plural(p.traps, 'hidden click-trap'));
  if (blocked) reasons.push(`${blocked} blocked by the shield`);
  if (p.adNets && p.adNets.length) reasons.push(`pop-up ad network${p.adNets.length > 1 ? 's' : ''} (${p.adNets.slice(0, 2).join(', ')})`);
  // One stray pop-up or redirect isn't enough on its own; a click-trap or a
  // shield block is.
  const score = (r.popups || 0) + (r.redirects || 0) + 2 * ((p.traps || 0) + blocked) + Math.min((p.adNets || []).length, 3);
  return { score, reasons };
}

async function loadRisk() {
  if (!state.tab || !/^https?:/i.test(state.tab.url || '')) return;
  const site = AVD.siteKey(state.tab.url);
  const [r, d] = await Promise.all([send({ type: 'avd:risk', site }), api.storage.session.get('avd:riskDismissed').catch(() => ({}))]);
  state.risk = (r && r.risk) || null;
  state.riskDismissed = ((d && d['avd:riskDismissed']) || []).includes(site);
  renderRisk();
}

async function markSketchy(on) {
  const site = AVD.siteKey(state.tab.url);
  const r = await send({ type: 'avd:sketchy', tabId: state.tab.id, site, on });
  const sites = new Set(state.settings.sketchySites || []);
  if (on) sites.add(site);
  else sites.delete(site);
  state.settings.sketchySites = [...sites];
  if (r && 'shield' in r) state.shield = r.shield;
  toast(on ? `${site} marked as sketchy — protection is on` : `${site} is no longer marked`);
  renderShield();
  renderRisk();
  renderSketchyList();
}

function renderRisk() {
  const card = $('riskCard');
  const web = state.tab && /^https?:/i.test(state.tab.url || '');
  if (!web || state.locked) return (card.hidden = true);
  const sketchy = isSketchy();
  const { score, reasons } = riskInfo();
  card.classList.toggle('protected', sketchy);
  if (sketchy) {
    card.hidden = false;
    const n = (state.shield && state.shield.blocked) || 0;
    $('riskTitle').textContent = 'Protected site';
    $('riskSub').textContent = `Ad links, pop-ups, redirects and hidden click-traps are blocked here${n ? ` · ${n} blocked on this tab` : ''}.`;
    $('riskMark').hidden = true;
    $('riskDismiss').textContent = 'Unmark';
    return;
  }
  card.hidden = score < 2 || state.riskDismissed;
  $('riskTitle').textContent = 'This site looks sketchy';
  $('riskSub').textContent = `Detected ${reasons.join(', ')}. Mark it to block ad links, pop-ups and redirects every time you visit.`;
  $('riskMark').hidden = false;
  $('riskDismiss').textContent = 'Not now';
}

function renderSketchyList() {
  const list = $('sketchyList');
  const sites = state.settings.sketchySites || [];
  list.replaceChildren(
    ...(sites.length
      ? sites.map((site) =>
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'row-title', text: site }),
            h(
              'button',
              {
                type: 'button',
                class: 'round-btn',
                title: 'Remove',
                'aria-label': 'Remove ' + site,
                onclick: async () => {
                  await send({ type: 'avd:sketchy', site, on: false, tabId: state.tab && AVD.siteKey(state.tab.url) === site ? state.tab.id : null });
                  state.settings.sketchySites = (state.settings.sketchySites || []).filter((x) => x !== site);
                  renderSketchyList();
                  renderRisk();
                  renderShield();
                },
              },
              icon('i-x')
            )
          )
        )
      : [h('div', { class: 'row-note pad top', text: 'No sites yet. Adaptive suggests marking one when it throws pop-ups or redirects at you.' })])
  );
}

async function verifyTemplate(c) {
  const t = c.tpl;
  const start = t.min === 0 ? 0 : 1;
  const n = start + Math.floor(Math.random() * (Math.max(t.max, start + 1) - start + 1));
  const url = t.pre + (t.pad > 0 ? String(n).padStart(t.pad, '0') : String(n)) + t.post;
  c.verify = 'busy';
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'include' });
    try {
      res.body && res.body.cancel && res.body.cancel().catch(() => {});
    } catch (e) {}
    c.verify = res.ok ? 'ok' : 'fail';
    c.verifyMsg = res.ok ? `Random segment #${n} answered` : `Segment #${n} returned HTTP ${res.status}`;
  } catch (e) {
    c.verify = 'fail';
    c.verifyMsg = `Segment #${n} failed (${(e && e.message) || 'network error'})`;
  }
}

async function scan() {
  state.scanning = true;
  state.candidates = state.candidates.filter((c) => c.userAdded);
  renderDownload();
  $('rescanBtn').classList.add('spin');
  const tab = state.tab;
  const [resp, page] = await Promise.all([send({ type: 'avd:candidates', tabId: tab.id }), probePage()]);
  state.page = page;
  state.title = AVD.cleanTitle((page && page.ogTitle) || tab.title || '', tab.url) || AVD.siteName(tab.url);
  const user = state.candidates;
  state.candidates = [...user, ...buildCandidates(resp, page).filter((c) => !user.some((u) => u.id === c.id))];
  state.scanning = false;
  $('rescanBtn').classList.remove('spin');
  renderDownload();

  if (state.candidates.length) ensureThumb();
  const known = new Set();
  state.pageCaptions = [...((page && page.captions) || []), ...((resp && resp.captions) || []).map((c) => ({ kind: 'file', url: c.url }))]
    .map(normCaption)
    .filter((c) => (known.has(c.id) ? false : known.add(c.id)));
  Promise.all(state.pageCaptions.filter((c) => c.status === 'checking').slice(0, 15).map(checkCaption)).then(renderDownload);
  loadRisk();
  const pending = state.candidates.filter((c) => c.status === 'loading');
  // Preview with the page as Referer, like the real download will.
  const ref = state.settings.sendReferer && /^https?:/i.test(tab.url || '') ? tab.url : '';
  if (pending.length && ref) await send({ type: 'avd:scanHeaders', referer: ref });
  await Promise.all(pending.map((c) => describe(c).then(renderDownload)));
  if (pending.length && ref) send({ type: 'avd:scanHeaders', referer: null });
  // Fold variant/audio playlists into their master (when the background
  // couldn't, e.g. they came from the page's resource log).
  const kids = new Set(state.candidates.flatMap((c) => c.childUrls || []));
  if (kids.size) {
    state.candidates = state.candidates.filter((c) => c.type === 'template' || c.type === 'file' || !kids.has(bare(c.url)));
    if (!selected()) state.selectedId = null;
    renderDownload();
  }
  const best = pickBest();
  if (best && best.type === 'template' && !best.verify) {
    await verifyTemplate(best);
    renderDownload();
  }
}

/* ---------------- jobs ---------------- */

function engineBusy() {
  const e = state.engine;
  return !!(e && ((e.active && RUNNING.has(e.active.phase) && !isStale(e)) || (e.queue && e.queue.length)));
}

function isStale(e) {
  return !!(e && e.active && RUNNING.has(e.active.phase) && Date.now() - (e.ts || 0) > 20000);
}

function extFor(c, format) {
  if (format === 'audio') return '.m4a';
  if (format === 'original') {
    if (c.type === 'file') return '.' + ((/\.([a-z0-9]{2,4})$/i.exec(bare(c.url)) || [])[1] || 'mp4').toLowerCase();
    if (c.type === 'template') return '.' + (c.tpl.ext === 'm4s' ? 'mp4' : c.tpl.ext || 'ts');
    return c.type === 'dash' ? '.mp4' : '.ts';
  }
  if (c.type === 'file' && format === 'auto') return '.' + ((/\.([a-z0-9]{2,4})$/i.exec(bare(c.url)) || [])[1] || 'mp4').toLowerCase();
  return '.mp4';
}

function makeJob(c, mode) {
  const s = state.settings;
  const m = state.manual;
  const manual = mode === 'manual';
  const variant = (manual && m.variantKey && c.variants.find((v) => v.key === m.variantKey)) || bestVariant(c);
  const audio = (manual && m.audioKey && c.audios.find((a) => a.key === m.audioKey)) || null;
  const quality = variant ? AVD.qualityLabel(variant) : '';
  const title = state.title || candName(c);
  const site = AVD.siteName(state.tab.url);
  const filename = manual && m.filename.trim()
    ? AVD.sanitizeFilename(m.filename.trim())
    : AVD.applyTemplate(s.filenameTemplate, { title, site, quality });

  let source;
  if (c.type === 'template') {
    const t = c.tpl;
    source = { type: 'template', pre: t.pre, post: t.post, pad: t.pad, start: t.min === 0 ? 0 : 1, max: t.max, ext: t.ext };
  } else if (c.type === 'file') {
    source = { type: 'file', url: c.url, mime: c.mime };
  } else {
    source = {
      type: c.type,
      url: c.url,
      variant: variant ? { key: variant.key, height: variant.height, bandwidth: variant.bandwidth } : null,
      audio: audio ? { key: audio.key } : null,
    };
  }

  let range = null;
  if (manual && !m.whole && c.type !== 'file') {
    const parse = c.type === 'template' ? (x) => (String(x).trim() ? parseInt(String(x).replace('#', ''), 10) : NaN) : AVD.parseClock;
    const from = parse(m.from);
    const to = parse(m.to);
    if ((String(m.from).trim() && !isFinite(from)) || (String(m.to).trim() && !isFinite(to))) {
      toast(c.type === 'template' ? 'Range must be segment numbers' : 'Use times like 1:30 or 1:02:03');
      return null;
    }
    if (isFinite(from) && isFinite(to) && to <= from) {
      toast('“To” must be after “From”');
      return null;
    }
    range = { from: isFinite(from) ? from : null, to: isFinite(to) ? to : null };
  }

  const options = manual
    ? {
        format: m.format,
        keepOriginal: m.keepOriginal,
        concurrency: m.adaptive ? 0 : m.conc,
        retries: m.retries,
        timeout: m.timeout,
        delayMs: m.delay,
        onMissing: m.onMissing,
        range,
        live: m.live,
        liveMaxSeconds: m.liveMax * 60,
        referer: m.referer.trim(),
        sendCookies: m.cookies,
        subfolder: s.subfolder,
        saveAs: s.saveAs,
      }
    : {
        format: s.format,
        keepOriginal: s.keepOriginal,
        concurrency: s.concurrency,
        retries: s.retries,
        timeout: s.timeout,
        delayMs: s.delayMs || 0,
        onMissing: s.onMissing,
        range: null,
        live: true,
        liveMaxSeconds: 0,
        referer: s.sendReferer ? state.tab.url || '' : '',
        sendCookies: s.sendCookies,
        subfolder: s.subfolder,
        saveAs: s.saveAs,
      };

  const caps = captionsFor(c).filter((x) => x.status === 'ready' && (manual ? !m.capOff.has(x.id) : s.captions));
  options.captionFormat = manual ? m.capFormat : s.captionFormat;
  options.captionEmbed = manual ? m.capEmbed : s.captionEmbed;
  options.captionSidecar = true;

  return {
    id: AVD.uid('job'),
    mode,
    title,
    captions: options.format === 'audio' ? [] : caps.map(captionSource),
    filename,
    site,
    pageUrl: state.tab.url || '',
    favicon: (state.tab.favIconUrl && state.tab.favIconUrl.length < 2048 && state.tab.favIconUrl) || '',
    thumb: state.thumb || '',
    qualityHint: quality,
    source,
    options,
  };
}

async function startDownload(c, mode, btn) {
  if (!c || c.drm) return;
  const job = makeJob(c, mode);
  if (!job) return;
  if (btn) btn.disabled = true;
  try {
    if (!job.thumb) {
      job.thumb = await Promise.race([ensureThumb(), new Promise((r) => setTimeout(() => r(''), 1500))]);
    }
    const busy = engineBusy();
    const r = await send({ type: 'avd:enqueue', job });
    if (!r || !r.ok) {
      toast('Couldn’t start the download — try again');
      return;
    }
    toast(busy ? 'Added to the queue' : c.live ? 'Recording started' : 'Download started');
    $('scroller').scrollTo({ top: 0, behavior: 'smooth' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------- Download view ---------------- */

function renderDownload() {
  const locked = !!state.locked;
  const has = state.candidates.length > 0;
  $('lockdown').hidden = !locked;
  $('scanning').hidden = locked || !state.scanning || has;
  $('emptyState').hidden = locked || state.scanning || has || state.mode === 'manual';
  $('autoView').hidden = locked || !has || state.mode !== 'auto';
  $('manualView').hidden = locked || state.mode !== 'manual' || (state.scanning && !has);
  if (!locked && state.mode === 'auto' && has) renderAuto();
  if (!locked && state.mode === 'manual') renderManual();
  renderSafe();
  renderRisk();
  renderCta();
}

// Full card when nothing is found; a compact one once a video is listed.
function renderSafe() {
  const web = state.tab && /^https?:/i.test(state.tab.url || '');
  const card = $('safePlay');
  const playButton = !!(state.page && state.page.needsPlay);
  card.hidden = !!state.locked || !web || !(playButton || state.safeBusy || state.safeShown);
  const compact = state.candidates.length > 0;
  card.classList.toggle('compact', compact);
  $('safeTitle').textContent = compact ? 'Wrong video, or ads in the way?' : 'Play button sends you to ads?';
  $('safeSub').textContent = compact
    ? 'Let Adaptive start the real video — no clicks on the page.'
    : 'Let Adaptive start the video for you. Fake play buttons and pop-ups can’t hijack it.';
  $('safeHint').hidden = !playButton || compact;
  card.classList.toggle('top', compact && state.mode === 'manual');
  $('emptyState').classList.toggle('slim', !card.hidden);
}

function statusLine(el, cls, text) {
  el.className = 'status-line ' + (cls || '');
  el.querySelector('.txt').textContent = text;
}

function renderAuto() {
  const c = pickBest();
  if (!c) return;
  const v = bestVariant(c);
  const media = $('heroMedia');
  media.style.setProperty('--hue', hue(state.site + state.title));
  const img = $('heroThumb');
  if (state.thumb) {
    if (img.getAttribute('src') !== state.thumb) img.src = state.thumb;
    img.hidden = false;
    $('heroPh').hidden = true;
  } else {
    img.hidden = true;
    $('heroPh').hidden = false;
  }
  const q = v ? AVD.qualityLabel(v) : '';
  $('heroQuality').hidden = !q;
  $('heroQuality').textContent = q;
  const dur = c.duration || (state.page && state.page.duration) || 0;
  $('heroDuration').hidden = !dur || c.live;
  $('heroDuration').textContent = AVD.formatDuration(dur);
  $('heroLive').hidden = !c.live;
  $('heroTitle').textContent = state.title || candName(c);

  const size = sizeEstimate(c, v);
  const meta = $('heroMeta');
  meta.replaceChildren(
    ...[TYPE_LABEL[c.type], size ? (c.type === 'file' ? '' : '~') + AVD.formatBytes(size) : '', candHost(c)]
      .filter(Boolean)
      .map((t) => h('span', { text: t }))
  );

  const caps = captionsFor(c).filter((x) => x.status === 'ready');
  $('heroCC').hidden = !caps.length;
  if (caps.length) {
    const langs = [...new Set(caps.map((x) => AVD_Captions.labelOf(x)))];
    $('heroCCText').textContent = langs.slice(0, 3).join(', ') + (langs.length > 3 ? ` +${langs.length - 3}` : '');
    $('heroCCNote').textContent = state.settings.captions ? `· .${state.settings.captionFormat} included` : '';
    $('heroCCSave').textContent = state.settings.captions ? 'Save only' : `Save .${state.settings.captionFormat}`;
  }

  const st = $('heroStatus');
  if (c.drm) statusLine(st, 'err', 'DRM-protected — this video can’t be downloaded');
  else if (c.status === 'loading') statusLine(st, 'busy', 'Checking the stream…');
  else if (c.status === 'error') statusLine(st, 'warn', 'Couldn’t preview this stream — downloading may still work');
  else if (c.verify === 'busy') statusLine(st, 'busy', 'Testing a random segment…');
  else if (c.verify === 'fail') statusLine(st, 'warn', (c.verifyMsg || 'Test failed') + ' — you can still try');
  else if (c.live) statusLine(st, 'ok', 'Live — records until you press Stop');
  else statusLine(st, 'ok', c.verify === 'ok' ? 'Verified — ready to download' : 'Ready to download');

  const btn = $('autoDownload');
  btn.disabled = !!c.drm;
  btn.querySelector('span').textContent = engineBusy() ? 'Add to queue' : c.live ? 'Record live' : 'Download';
  btn.onclick = () => startDownload(c, 'auto', btn);

  const fmt = state.settings.format;
  const fmtLabel =
    fmt === 'audio' ? 'Audio only' : fmt === 'original' ? 'Original format' : c.type === 'file' && fmt === 'auto' ? 'Original file' : 'MP4';
  const speed = state.settings.concurrency ? `${state.settings.concurrency} parallel` : 'Adaptive speed';
  $('heroFoot').textContent = `${c.type === 'file' ? 'Full file' : 'Best quality'} · ${fmtLabel} · ${speed}`;

  const others = state.candidates.filter((x) => x !== c && !x.covered).length;
  $('moreSources').hidden = others === 0;
  $('moreText').textContent = others === 1 ? '1 other source found' : `${others} other sources found`;
}

function selected() {
  return state.candidates.find((c) => c.id === state.selectedId) || null;
}

function renderManual() {
  if (!selected()) {
    const b = pickBest();
    state.selectedId = b ? b.id : null;
  }
  renderSources();
  renderManualOptions();
}

function renderSources() {
  const list = $('sourceList');
  const all = ranked();
  const best = all[0];
  const visible = all.filter((c) => !c.covered || state.showCovered || c.id === state.selectedId);
  const hiddenCount = all.length - visible.length;
  const rows = visible.map((c) => {
    const tags = [];
    if (c === best && all.length > 1 && !c.drm) tags.push(h('span', { class: 'src-tag best', text: 'BEST' }));
    if (c.live) tags.push(h('span', { class: 'src-tag live', text: 'LIVE' }));
    const ic = h('div', { class: 'src-icon ' + (c.drm ? 'drm' : c.type) }, icon(c.drm ? 'i-lock' : TYPE_ICON[c.type]));
    const sub = h('div', { class: 'src-sub' });
    if (c.status === 'loading') sub.append(h('span', { class: 'spinner mini-spin' }));
    sub.append(c.drm ? 'DRM-protected · can’t download' : candSub(c));
    return h(
      'button',
      {
        type: 'button',
        class: 'source' + (c.id === state.selectedId ? ' sel' : '') + (c.drm ? ' disabled' : ''),
        title: c.type === 'template' ? c.tpl.pre + '#' + c.tpl.post.split('?')[0] : c.url,
        onclick: () => {
          if (c.drm) return toast('DRM-protected video can’t be downloaded');
          if (state.selectedId !== c.id) {
            state.selectedId = c.id;
            state.manual.variantKey = null;
            state.manual.audioKey = null;
            state.manual.whole = true;
            state.manual.from = state.manual.to = '';
            $('testResult').hidden = true;
          }
          renderManual();
          renderCta();
        },
      },
      ic,
      h('div', { class: 'src-info' }, h('div', { class: 'src-name' }, TYPE_LABEL[c.type] + ' — ' + candName(c), ...tags), sub),
      h('span', { class: 'radio' }, icon('i-check'))
    );
  });
  if (hiddenCount > 0 || (state.showCovered && all.some((c) => c.covered))) {
    rows.push(
      h('button', {
        type: 'button',
        class: 'src-more',
        text: state.showCovered ? 'Hide raw segment patterns' : `Show ${hiddenCount} raw segment pattern${hiddenCount === 1 ? '' : 's'}`,
        onclick: () => {
          state.showCovered = !state.showCovered;
          renderSources();
        },
      })
    );
  }
  if (!rows.length) {
    rows.push(h('div', { class: 'src-empty', text: state.scanning ? 'Scanning…' : 'Nothing detected yet — play the video, rescan, or paste a link below.' }));
  }
  list.replaceChildren(...rows);
}

const FORMAT_NOTES = {
  auto: 'Best container automatically — MP4 for streams, untouched for files.',
  mp4: 'Remuxed to MP4 without re-encoding — lossless and fast.',
  original: 'Saved exactly as the server sends it.',
  audio: 'Audio track only — M4A, or MP3 when it can’t be copied.',
};

function renderManualOptions() {
  const c = selected();
  const m = state.manual;
  $('manualOptions').hidden = !c;
  if (!c) return;

  // quality / audio
  const qs = c.variants;
  $('rowQuality').hidden = qs.length < 1;
  $('rowAudio').hidden = c.audios.length < 1;
  $('videoGroup').hidden = qs.length < 1 && c.audios.length < 1;
  const qSel = $('qualitySel');
  const qKey = m.variantKey || (bestVariant(c) || {}).key || '';
  qSel.replaceChildren(
    ...qs.map((v) => {
      const est = sizeEstimate(c, v);
      const label = v.audioOnly
        ? `Audio only · ${AVD.bitrateLabel(v.bandwidth)}`
        : [AVD.qualityLabel(v) || 'Default', AVD.bitrateLabel(v.bandwidth), est ? '~' + AVD.formatBytes(est) : ''].filter(Boolean).join(' · ');
      return h('option', { value: v.key, text: label, selected: v.key === qKey });
    })
  );
  const aSel = $('audioSel');
  aSel.replaceChildren(
    h('option', { value: '', text: 'Default', selected: !m.audioKey }),
    ...c.audios.map((a) =>
      h('option', {
        value: a.key,
        text: [a.name || a.lang || 'Track', a.lang && a.name ? a.lang : '', a.bandwidth ? AVD.bitrateLabel(a.bandwidth) : ''].filter(Boolean).join(' · '),
        selected: a.key === m.audioKey,
      })
    )
  );

  renderCaptionGroup(c);

  // output
  formatCtl.set(m.format);
  $('formatNote').textContent = FORMAT_NOTES[m.format] || '';
  $('keepOriginal').checked = m.keepOriginal;
  $('keepOriginal').closest('.row').hidden = m.format === 'original' || (c.type === 'file' && m.format === 'auto');
  if (!m.filenameEdited) {
    const v = (m.variantKey && c.variants.find((x) => x.key === m.variantKey)) || bestVariant(c);
    m.filename = AVD.applyTemplate(state.settings.filenameTemplate, {
      title: state.title || candName(c),
      site: AVD.siteName(state.tab.url),
      quality: v ? AVD.qualityLabel(v) : '',
    });
  }
  if (document.activeElement !== $('filenameInput')) $('filenameInput').value = m.filename;
  $('extHint').textContent = extFor(c, m.format);

  // range
  $('rangeGroup').hidden = c.type === 'file' || c.live;
  $('wholeToggle').checked = m.whole;
  $('rangeRow').hidden = m.whole;
  $('rangeNote').hidden = m.whole;
  const isTpl = c.type === 'template';
  $('rangeFrom').placeholder = isTpl ? '#' + (c.tpl.min === 0 ? 0 : 1) : '0:00';
  $('rangeTo').placeholder = isTpl ? 'auto' : c.duration ? AVD.formatDuration(c.duration) : 'end';
  if (document.activeElement !== $('rangeFrom')) $('rangeFrom').value = m.from;
  if (document.activeElement !== $('rangeTo')) $('rangeTo').value = m.to;
  $('rangeNote').textContent = isTpl
    ? 'Segment numbers. Leave “to” empty to detect the end automatically.'
    : `Times as m:ss or h:mm:ss${c.duration ? ' · video is ' + AVD.formatDuration(c.duration) : ''}.`;

  // live
  $('liveGroup').hidden = !c.live;
  $('liveToggle').checked = m.live;

  // network
  $('adaptiveToggle').checked = m.adaptive;
  $('concRow').hidden = m.adaptive;
  $('cookiesToggle').checked = m.cookies;
  if (document.activeElement !== $('refererInput')) $('refererInput').value = m.referer;
  missingCtl.set(m.onMissing);
}

function renderCaptionGroup(c) {
  const m = state.manual;
  const caps = captionsFor(c).filter((x) => x.status !== 'bad');
  $('ccGroup').hidden = !caps.length || m.format === 'audio';
  if (!caps.length) return;
  $('ccList').replaceChildren(
    ...caps.map((cap) => {
      const on = !m.capOff.has(cap.id);
      const sub = h('div', { class: 'src-sub' });
      if (cap.status === 'checking') sub.append(h('span', { class: 'spinner mini-spin' }), 'Checking…');
      else sub.append(captionSub(cap));
      return h(
        'div',
        { class: 'source cc-item' + (on ? ' sel' : '') },
        h(
          'button',
          {
            type: 'button',
            class: 'cc-toggle',
            'aria-pressed': on ? 'true' : 'false',
            title: on ? 'Included with the video' : 'Not included',
            onclick: () => {
              if (on) m.capOff.add(cap.id);
              else m.capOff.delete(cap.id);
              renderCaptionGroup(c);
            },
          },
          h('span', { class: 'radio' }, icon('i-check')),
          h('div', { class: 'src-info' }, h('div', { class: 'src-name' }, h('span', { class: 'cc-badge', text: 'CC' }), captionName(cap)), sub)
        ),
        h(
          'button',
          { type: 'button', class: 'btn-tinted cc-save', disabled: cap.status !== 'ready', title: `Save as .${m.capFormat} now`, onclick: (e) => saveCaptionsNow([cap], e.currentTarget) },
          icon('i-download'),
          '.' + m.capFormat
        )
      );
    })
  );
  $('ccEmbed').checked = m.capEmbed;
  $('ccEmbedRow').hidden = m.format === 'original' || (c.type === 'file' && m.format === 'auto');
}

function renderCta() {
  const c = selected();
  const show = state.view === 'download' && state.mode === 'manual' && !state.locked && !!c;
  $('ctaBar').hidden = !show;
  document.querySelector('.app').classList.toggle('has-cta', show);
  if (!show) return;
  const btn = $('manualDownload');
  btn.disabled = !!c.drm;
  btn.querySelector('span').textContent = engineBusy() ? 'Add to queue' : c.live && state.manual.live ? 'Record live' : 'Download';
}

async function addLink() {
  const input = $('linkInput');
  const url = input.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    toast('Paste a full http(s) link');
    input.focus();
    return;
  }
  input.value = '';
  const kind = AVD_Manifest.kindOf(url);
  const c = { id: 'u:' + bare(url), type: kind || 'file', url, ts: Date.now(), status: 'loading', userAdded: true, variants: [], audios: [], size: 0, mime: '' };
  state.candidates = [c, ...state.candidates.filter((x) => x.id !== c.id)];
  state.selectedId = c.id;
  state.manual.variantKey = state.manual.audioKey = null;
  renderDownload();
  if (kind) {
    await describe(c);
  } else {
    // No telltale extension: it may still be a playlist served without one.
    try {
      const d = await AVD_Manifest.describe(url, { timeout: 8 });
      c.type = d.type;
      Object.assign(c, { status: 'ready', ...d });
    } catch (e) {
      c.type = 'file';
      c.status = 'ready';
    }
  }
  renderDownload();
}

async function testConnection() {
  const c = selected();
  if (!c) return;
  const el = $('testResult');
  el.hidden = false;
  statusLine(el, 'busy', 'Testing…');
  if (c.type === 'template') {
    await verifyTemplate(c);
    statusLine(el, c.verify === 'ok' ? 'ok' : 'err', c.verifyMsg);
  } else if (c.type === 'file') {
    try {
      const res = await fetch(c.url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', credentials: state.manual.cookies ? 'include' : 'omit' });
      try {
        res.body && res.body.cancel && res.body.cancel().catch(() => {});
      } catch (e) {}
      const total = (/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '') || [])[1];
      if (res.status === 206) statusLine(el, 'ok', `OK · supports fast parallel download${total ? ' · ' + AVD.formatBytes(+total) : ''}`);
      else if (res.ok) statusLine(el, 'ok', 'OK · single-stream download');
      else statusLine(el, 'err', `Server answered HTTP ${res.status}`);
    } catch (e) {
      statusLine(el, 'err', 'Request failed: ' + ((e && e.message) || 'network error'));
    }
  } else {
    c.status = 'loading';
    renderSources();
    await describe(c);
    renderManual();
    if (c.status === 'ready') {
      const n = c.variants.filter((v) => !v.audioOnly).length;
      statusLine(el, c.drm ? 'err' : 'ok', c.drm ? 'DRM-protected' : `Stream OK${n ? ' · ' + n + ' qualit' + (n === 1 ? 'y' : 'ies') : ''}${c.duration ? ' · ' + AVD.formatDuration(c.duration) : ''}`);
    } else {
      statusLine(el, 'err', 'Couldn’t read the stream: ' + c.error);
    }
  }
}

/* ---------------- engine (active download + queue) ---------------- */

function phaseText(a) {
  if (a.paused) return 'Paused';
  return { resolving: 'Preparing', downloading: 'Downloading', recording: 'Recording', processing: 'Finishing' }[a.phase] || '';
}

function statsFor(a) {
  const out = [];
  const pct = a.pct >= 0 ? Math.floor(a.pct) + '%' : '';
  if (a.phase === 'resolving') out.push(h('b', { text: a.message || 'Preparing…' }));
  else if (a.phase === 'processing') out.push(h('b', { text: a.message || 'Finishing…' }), a.pct > 0 ? pct : '');
  else if (a.phase === 'recording') {
    out.push(h('b', { text: '● ' + (AVD.formatDuration(a.recorded) || '0:00') + ' recorded' }));
    if (a.bytes) out.push(AVD.formatBytes(a.bytes));
    if (a.speed) out.push(AVD.formatSpeed(a.speed));
  } else {
    out.push(h('b', { text: a.paused ? 'Paused · ' + pct : pct || '…' }));
    if (a.bytes) out.push(AVD.formatBytes(a.bytes) + (a.estBytes > a.bytes ? ' of ~' + AVD.formatBytes(a.estBytes) : ''));
    if (a.speed && !a.paused) out.push(AVD.formatSpeed(a.speed));
    if (a.eta > 1 && !a.paused) out.push(AVD.formatDuration(a.eta) + ' left');
    if (a.totalSegs > 1) out.push(`${a.doneSegs}/${a.totalSegs} parts`);
  }
  return out.filter(Boolean).map((x) => (typeof x === 'string' ? h('span', { text: x }) : x));
}

function control(actionName, id) {
  send({ type: 'avd:control', action: actionName, id });
}

function openFile(f) {
  if (!f || f.id == null) return;
  try {
    const p = api.downloads.open(f.id);
    if (p && p.catch) p.catch(() => api.downloads.show(f.id));
  } catch (e) {
    try {
      api.downloads.show(f.id);
    } catch (e2) {}
  }
}

function showFile(f) {
  if (!f || f.id == null) return;
  try {
    api.downloads.show(f.id);
  } catch (e) {}
}

function liveCard(a) {
  const card = h('article', { class: 'dl-card glass', 'data-id': a.id });
  const cancel = h('button', { type: 'button', class: 'round-btn', title: 'Cancel and discard', 'aria-label': 'Cancel and discard' }, icon('i-x'));
  cancel.onclick = () => {
    if (cancel.classList.contains('confirm')) return control('cancel', a.id);
    cancel.classList.add('confirm');
    cancel.replaceChildren('Discard?');
    setTimeout(() => {
      cancel.classList.remove('confirm');
      cancel.replaceChildren(icon('i-x'));
    }, 3000);
  };
  const sub = [a.site, a.quality, phaseText(a) + (a.connections > 1 && a.phase === 'downloading' && !a.paused ? ` · ${a.connections} connections` : '')]
    .filter(Boolean)
    .join(' · ');
  card.append(
    h('div', { class: 'dl-top' }, thumbEl(a.thumb, a.site + a.title), h('div', { class: 'dl-info' }, h('div', { class: 'dl-title', text: a.title, title: a.title }), h('div', { class: 'dl-sub', text: sub })), cancel)
  );
  const bar = h('div', { class: 'progress' }, h('div', { class: 'fill' }));
  const indet = a.pct < 0 || a.phase === 'resolving' || (a.phase === 'processing' && !(a.pct > 0));
  bar.classList.toggle('indeterminate', indet);
  bar.classList.toggle('paused', !!a.paused);
  bar.classList.toggle('live', a.phase === 'recording');
  if (!indet) bar.firstChild.style.width = Math.max(1.5, Math.min(100, a.pct)) + '%';
  card.append(bar, h('div', { class: 'dl-stats' }, statsFor(a)));

  const actions = h('div', { class: 'dl-actions' });
  if (a.canPause) {
    actions.append(
      a.paused
        ? h('button', { type: 'button', class: 'btn-tinted', onclick: () => control('resume', a.id) }, icon('i-play'), 'Resume')
        : h('button', { type: 'button', class: 'btn-tinted', onclick: () => control('pause', a.id) }, icon('i-pause'), 'Pause')
    );
  }
  if (a.canStop) {
    actions.append(
      h(
        'button',
        { type: 'button', class: 'btn-tinted neutral', title: 'Stop and save what’s downloaded', onclick: () => control('stop', a.id) },
        icon('i-stop'),
        a.phase === 'recording' ? 'Stop & save' : 'Stop & save'
      )
    );
  }
  actions.append(detailsButton(a, card));
  card.append(actions);
  if (state.logOpen.has(a.id)) card.append(logEl(a));
  return card;
}

function detailsButton(a, card) {
  return h(
    'button',
    {
      type: 'button',
      class: 'btn-tinted neutral',
      onclick: () => {
        if (state.logOpen.has(a.id)) state.logOpen.delete(a.id);
        else state.logOpen.add(a.id);
        const existing = card.querySelector('.dl-log');
        if (existing) existing.remove();
        else card.append(logEl(a));
      },
    },
    icon('i-sliders'),
    'Details'
  );
}

function logEl(a) {
  const el = h('div', { class: 'dl-log', text: (a.log || []).join('\n') || 'No details yet.' });
  requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  return el;
}

function doneCard(a, stale) {
  const ok = a.status === 'complete' || a.status === 'partial';
  const badgeCls = stale || a.phase === 'error' ? 'error' : a.status === 'partial' || a.phase === 'canceled' ? 'partial' : '';
  const card = h('article', { class: 'dl-card glass', 'data-id': a.id });
  const file = (a.files || []).find((f) => f.ok && f.id != null);
  const size = (a.files || []).reduce((n, f) => n + (f.ok ? f.size : 0), 0);
  const msg = stale ? 'Interrupted — the background worker stopped' : a.message;
  const failed = stale || a.phase === 'error';
  const dismiss = h('button', { type: 'button', class: 'round-btn', title: 'Dismiss', 'aria-label': 'Dismiss' }, icon('i-x'));
  dismiss.onclick = () => {
    if (stale) {
      api.storage.session.set({ [K.state]: { ...state.engine, active: null } }).catch(() => {});
    } else control('dismiss', a.id);
  };
  card.append(
    h(
      'div',
      { class: 'dl-top' },
      thumbEl(a.thumb, a.site + a.title),
      h(
        'div',
        { class: 'dl-info' },
        h('div', { class: 'dl-title', text: a.title, title: a.title }),
        h('div', { class: 'dl-sub', text: failed ? 'Download failed' : [msg, ok ? AVD.formatBytes(size) : ''].filter(Boolean).join(' · ') })
      ),
      h('span', { class: 'done-badge ' + badgeCls }, icon(ok && !stale ? 'i-check' : 'i-alert')),
      dismiss
    )
  );
  if (failed) card.append(h('div', { class: 'dl-error', text: msg }));
  const actions = h('div', { class: 'dl-actions' });
  if (file && !stale) {
    actions.append(
      h('button', { type: 'button', class: 'btn-tinted', onclick: () => openFile(file) }, icon('i-play'), 'Open'),
      h('button', { type: 'button', class: 'btn-tinted neutral', onclick: () => showFile(file) }, icon('i-folder'), 'Show in folder')
    );
  }
  actions.append(detailsButton(a, card));
  card.append(actions);
  if (state.logOpen.has(a.id)) card.append(logEl(a));
  return card;
}

function queueCard(queue) {
  return h(
    'section',
    { class: 'queue glass' },
    h('div', { class: 'queue-head' }, icon('i-stack'), `Up next · ${queue.length}`),
    queue.map((j) =>
      h(
        'div',
        { class: 'q-row' },
        thumbEl(j.thumb, j.site + j.title),
        h('div', { class: 'dl-info' }, h('div', { class: 'dl-title', text: j.title }), h('div', { class: 'dl-sub', text: [j.site, j.quality].filter(Boolean).join(' · ') })),
        h('button', { type: 'button', class: 'round-btn', title: 'Remove from queue', 'aria-label': 'Remove from queue', onclick: () => control('dequeue', j.id) }, icon('i-x'))
      )
    )
  );
}

// Re-render the active area, but keep DOM stable when only numbers change so
// buttons don't flicker under the cursor.
let lastActiveSig = '';
function renderEngine() {
  const e = state.engine;
  const area = $('activeArea');
  const a = e && e.active;
  const stale = isStale(e);
  const running = !!(a && RUNNING.has(a.phase) && !stale);
  $('tabDot').hidden = !running;

  const show = a && !(a.phase === 'canceled' && a.discarded) && a.phase !== 'idle' ? a : null;
  const queue = (e && e.queue) || [];
  const sig = JSON.stringify([
    show && [show.id, show.phase, show.paused, show.canPause, show.canStop, stale, (show.files || []).length, state.logOpen.has(show.id)],
    queue.map((q) => q.id),
  ]);

  if (sig === lastActiveSig && show && running) {
    // Fast path: update text + bar in place.
    const card = area.querySelector(`.dl-card[data-id="${CSS.escape(show.id)}"]`);
    if (card) {
      const fresh = liveCard(show);
      card.querySelector('.dl-sub').textContent = fresh.querySelector('.dl-sub').textContent;
      card.querySelector('.dl-stats').replaceWith(fresh.querySelector('.dl-stats'));
      card.querySelector('.progress').replaceWith(fresh.querySelector('.progress'));
      const log = card.querySelector('.dl-log');
      if (log) {
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        log.textContent = (show.log || []).join('\n');
        if (atEnd) log.scrollTop = log.scrollHeight;
      }
      renderCta();
      return;
    }
  }
  lastActiveSig = sig;
  const nodes = [];
  if (show) nodes.push(running ? liveCard(show) : doneCard(show, stale));
  if (queue.length) nodes.push(queueCard(queue));
  area.replaceChildren(...nodes);
  if (state.mode === 'auto' && !state.locked && state.candidates.length) renderAuto();
  renderCta();
}

/* ---------------- History ---------------- */

async function loadHistory() {
  try {
    const d = await api.storage.local.get(K.history);
    state.history = (d && d[K.history]) || [];
  } catch (e) {
    state.history = [];
  }
  if (state.view === 'history') renderHistory();
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function historyRow(r) {
  const row = h('div', { class: 'h-row' + (state.openHistoryId === r.id ? ' open' : ''), 'data-id': r.id });
  const file = (r.files || []).find((f) => f.ok && f.id != null);
  const pill =
    r.status === 'partial'
      ? h('span', { class: 'pill partial', text: 'PARTIAL' })
      : r.status === 'failed'
      ? h('span', { class: 'pill failed', text: 'FAILED' })
      : r.live
      ? h('span', { class: 'pill live', text: 'LIVE' })
      : null;
  const sub = h(
    'div',
    { class: 'h-sub' },
    pill,
    [r.quality, (r.format || '').toUpperCase(), AVD.formatBytes(r.size), r.duration ? AVD.formatDuration(r.duration) : '', r.site].filter(Boolean).join(' · ')
  );
  const main = h(
    'button',
    {
      type: 'button',
      class: 'h-main',
      onclick: () => {
        state.openHistoryId = state.openHistoryId === r.id ? null : r.id;
        renderHistory();
      },
    },
    thumbEl(r.thumb, r.site + r.title, r.format === 'm4a' || r.format === 'mp3' ? 'i-wave' : 'i-film'),
    h('div', { class: 'h-info' }, h('div', { class: 'h-title', text: r.title, title: r.title }), sub),
    h('span', { class: 'h-time', text: timeLabel(r.finishedAt) })
  );
  const actions = h('div', { class: 'h-actions' });
  if (r.status === 'failed' && r.error) actions.append(h('div', { class: 'h-error', text: r.error }));
  if (file) {
    const open = h('button', { type: 'button', class: 'btn-tinted', onclick: () => openFile(file) }, icon('i-play'), 'Open');
    const show = h('button', { type: 'button', class: 'btn-tinted neutral', onclick: () => showFile(file) }, icon('i-folder'), 'Show');
    actions.append(open, show);
    if (state.openHistoryId === r.id && api.downloads.search) {
      api.downloads
        .search({ id: file.id })
        .then((items) => {
          const it = items && items[0];
          if (!it || it.exists === false || it.state === 'interrupted') {
            open.disabled = show.disabled = true;
            sub.prepend(h('span', { class: 'pill missing', text: 'FILE MOVED' }));
          }
        })
        .catch(() => {});
    }
  }
  if (r.pageUrl) {
    actions.append(
      h('button', { type: 'button', class: 'btn-tinted neutral', onclick: () => api.tabs.create({ url: r.pageUrl }) }, icon('i-external'), r.status === 'failed' ? 'Retry on page' : 'Page'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn-tinted neutral',
          onclick: () =>
            navigator.clipboard.writeText(r.pageUrl).then(
              () => toast('Link copied'),
              () => toast('Couldn’t copy')
            ),
        },
        icon('i-copy'),
        'Copy link'
      )
    );
  }
  actions.append(
    h(
      'button',
      {
        type: 'button',
        class: 'btn-tinted danger',
        onclick: async () => {
          state.history = state.history.filter((x) => x.id !== r.id);
          renderHistory();
          await send({ type: 'avd:history:remove', id: r.id });
        },
      },
      icon('i-trash'),
      'Remove'
    )
  );
  row.append(main, actions);
  return row;
}

function renderHistory() {
  const all = state.history;
  const q = state.historyQuery.trim().toLowerCase();
  const items = all.filter(
    (r) =>
      (state.historyFilter === 'all' || r.status === state.historyFilter) &&
      (!q || [r.title, r.site, r.quality, r.format, ...(r.files || []).map((f) => f.name)].join(' ').toLowerCase().includes(q))
  );
  const total = all.reduce((n, r) => n + (r.size || 0), 0);
  $('historySummary').textContent = all.length
    ? `${all.length} download${all.length === 1 ? '' : 's'}` + (total ? ` · ${AVD.formatBytes(total)} saved` : '') + (items.length !== all.length ? ` · showing ${items.length}` : '')
    : '';
  $('historySummary').hidden = !all.length;
  $('clearHistory').hidden = !all.length;
  $('historyEmpty').hidden = items.length > 0;
  $('historyEmptyTitle').textContent = all.length ? 'No matches' : 'No downloads yet';
  $('historyEmptyText').textContent = all.length
    ? 'Try a different search or filter.'
    : 'Everything you download shows up here, with quick access to the file and the page it came from.';

  const out = [];
  let group = null;
  let label = '';
  for (const r of items) {
    const l = dayLabel(r.finishedAt);
    if (l !== label) {
      label = l;
      out.push(h('div', { class: 'day-label', text: l }));
      group = h('div', { class: 'group glass' });
      out.push(group);
    }
    group.append(historyRow(r));
  }
  $('historyList').replaceChildren(...out);
}

/* ---------------- views ---------------- */

function setView(v) {
  state.view = v;
  const tabs = [...document.querySelectorAll('#tabbar button')];
  const i = tabs.findIndex((b) => b.dataset.view === v);
  $('tabbar').style.setProperty('--i', i);
  tabs.forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  for (const name of ['download', 'history', 'settings']) $('view-' + name).hidden = name !== v;
  $('modeWrap').hidden = v !== 'download' || !!state.locked;
  $('rescanBtn').hidden = v !== 'download' || !!state.locked;
  $('siteChip').hidden = v !== 'download';
  renderShield();
  $('viewTitle').textContent = v === 'history' ? 'History' : v === 'settings' ? 'Settings' : 'Adaptive';
  $('scroller').scrollTop = 0;
  if (v === 'history') renderHistory();
  renderCta();
}

function setMode(mode, persist) {
  state.mode = mode;
  modeCtl.set(mode);
  if (persist) saveSettings({ mode });
  renderDownload();
}

/* ---------------- wiring ---------------- */

let modeCtl;
let formatCtl;
let missingCtl;

function wireManual() {
  const m = () => state.manual;
  formatCtl = segmented($('formatSeg'), state.manual.format, (v) => {
    m().format = v;
    renderManualOptions();
  });
  missingCtl = segmented($('missingSeg'), state.manual.onMissing, (v) => (m().onMissing = v));
  segmented($('ccFormatSeg'), state.manual.capFormat, (v) => {
    m().capFormat = v;
    const c = selected();
    if (c) renderCaptionGroup(c);
  });
  $('ccEmbed').addEventListener('change', (e) => (m().capEmbed = e.target.checked));
  $('qualitySel').addEventListener('change', (e) => {
    m().variantKey = e.target.value;
    renderManualOptions();
  });
  $('audioSel').addEventListener('change', (e) => (m().audioKey = e.target.value || null));
  $('keepOriginal').addEventListener('change', (e) => (m().keepOriginal = e.target.checked));
  $('filenameInput').addEventListener('input', (e) => {
    m().filename = e.target.value;
    m().filenameEdited = !!e.target.value.trim();
  });
  $('wholeToggle').addEventListener('change', (e) => {
    m().whole = e.target.checked;
    renderManualOptions();
    if (!m().whole) $('rangeFrom').focus();
  });
  $('rangeFrom').addEventListener('input', (e) => (m().from = e.target.value));
  $('rangeTo').addEventListener('input', (e) => (m().to = e.target.value));
  $('liveToggle').addEventListener('change', (e) => {
    m().live = e.target.checked;
    renderCta();
  });
  stepper($('liveMax'), 0, (v) => (m().liveMax = v));
  $('adaptiveToggle').addEventListener('change', (e) => {
    m().adaptive = e.target.checked;
    $('concRow').hidden = m().adaptive;
  });
  slider($('concRange'), $('concVal'), state.manual.conc, (v) => (m().conc = v));
  stepper($('retriesStep'), state.manual.retries, (v) => (m().retries = v));
  stepper($('timeoutStep'), state.manual.timeout, (v) => (m().timeout = v));
  stepper($('delayStep'), state.manual.delay, (v) => (m().delay = v));
  $('cookiesToggle').addEventListener('change', (e) => (m().cookies = e.target.checked));
  $('refererInput').addEventListener('input', (e) => (m().referer = e.target.value));
  $('testBtn').addEventListener('click', testConnection);
  $('linkAdd').addEventListener('click', addLink);
  $('linkInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addLink();
  });
  $('clearSources').addEventListener('click', async () => {
    await send({ type: 'avd:clearTab', tabId: state.tab.id });
    state.candidates = [];
    state.selectedId = null;
    toast('List cleared');
    scan();
  });
  $('manualDownload').addEventListener('click', () => startDownload(selected(), 'manual', $('manualDownload')));
}

function wireSettings() {
  const s = state.settings;
  segmented($('setMode'), s.mode, (v) => saveSettings({ mode: v }));
  const fmt = $('setFormat');
  fmt.value = s.format;
  fmt.addEventListener('change', () => saveSettings({ format: fmt.value }));
  const bindSwitch = (id, key, after) => {
    const el = $(id);
    el.checked = !!s[key];
    el.addEventListener('change', () => {
      saveSettings({ [key]: el.checked });
      if (after) after(el.checked);
    });
  };
  bindSwitch('setKeepOriginal', 'keepOriginal');
  bindSwitch('setSaveAs', 'saveAs');
  bindSwitch('setReferer', 'sendReferer');
  bindSwitch('setCookies', 'sendCookies');
  bindSwitch('setNotify', 'notify');
  bindSwitch('setBadge', 'badge');
  bindSwitch('setShieldAuto', 'shieldWithSafePlay');
  bindSwitch('setCaptions', 'captions');
  bindSwitch('setCaptionEmbed', 'captionEmbed');
  segmented($('setCaptionFormat'), s.captionFormat, (v) => saveSettings({ captionFormat: v }));
  renderSketchyList();
  const tpl = $('setTemplate');
  tpl.value = s.filenameTemplate;
  tpl.addEventListener('input', () => saveSettings({ filenameTemplate: tpl.value.trim() || '{title}' }));
  const sub = $('setSubfolder');
  sub.value = s.subfolder;
  sub.addEventListener('input', () => saveSettings({ subfolder: AVD.sanitizeFolder(sub.value) }));

  const adaptive = $('setAdaptive');
  adaptive.checked = !s.concurrency;
  $('setConcRow').hidden = adaptive.checked;
  const conc = slider($('setConc'), $('setConcVal'), s.concurrency || 8, (v) => saveSettings({ concurrency: v }));
  adaptive.addEventListener('change', () => {
    $('setConcRow').hidden = adaptive.checked;
    const v = adaptive.checked ? 0 : parseInt($('setConc').value, 10) || 8;
    conc.set(v || 8);
    saveSettings({ concurrency: v });
  });
  stepper($('setRetries'), s.retries, (v) => saveSettings({ retries: v }));
  stepper($('setTimeout'), s.timeout, (v) => saveSettings({ timeout: v }));
  segmented($('setTheme'), s.theme, (v) => saveSettings({ theme: v }));

  const sw = $('setAccent');
  const paintAccent = () => sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === state.settings.accent));
  sw.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    saveSettings({ accent: b.dataset.value });
    paintAccent();
  });
  paintAccent();

  $('setClearTab').addEventListener('click', async () => {
    if (!state.tab) return;
    await send({ type: 'avd:clearTab', tabId: state.tab.id });
    state.candidates = [];
    toast('Forgot videos on this tab');
    scan();
  });
  $('setClearHistory').addEventListener('click', (e) =>
    confirmTap(e.currentTarget, 'Tap again to clear everything', async () => {
      await send({ type: 'avd:history:clear' });
      state.history = [];
      toast('History cleared');
    })
  );
  $('setReset').addEventListener('click', (e) =>
    confirmTap(e.currentTarget, 'Tap again to reset', async () => {
      await api.storage.local.set({ [K.settings]: { ...AVD.DEFAULT_SETTINGS } }).catch(() => {});
      location.reload();
    })
  );
  try {
    $('version').textContent = 'v' + api.runtime.getManifest().version;
  } catch (e) {}
}

function wireShell() {
  modeCtl = segmented($('modeSeg'), state.mode, (v) => setMode(v, true));
  document.querySelectorAll('#tabbar button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('rescanBtn').addEventListener('click', () => {
    state.thumbPromise = null;
    state.thumb = '';
    scan();
  });
  $('emptyRescan').addEventListener('click', () => scan());
  $('safePlayBtn').addEventListener('click', (e) => safePlay(e.currentTarget));
  $('safePlayMini').addEventListener('click', (e) => safePlay(e.currentTarget));
  $('shieldToggle').addEventListener('change', (e) => setShield(e.target.checked, false));
  $('shieldChip').addEventListener('click', () => {
    if (isSketchy()) return toast('This site is marked sketchy — unmark it below to turn protection off');
    setShield(false, false);
    toast('Pop-up shield off for this tab');
  });
  $('riskMark').addEventListener('click', () => markSketchy(true));
  $('riskDismiss').addEventListener('click', async () => {
    if (isSketchy()) return markSketchy(false);
    state.riskDismissed = true;
    renderRisk();
    try {
      const d = await api.storage.session.get('avd:riskDismissed');
      const list = (d && d['avd:riskDismissed']) || [];
      list.push(AVD.siteKey(state.tab.url));
      await api.storage.session.set({ 'avd:riskDismissed': list });
    } catch (e) {}
  });
  $('heroCCSave').addEventListener('click', (e) => saveCaptionsNow(captionsFor(pickBest()).filter((x) => x.status === 'ready'), e.currentTarget));
  $('ccSaveAll').addEventListener('click', (e) => saveCaptionsNow(captionsFor(selected()).filter((x) => x.status === 'ready' && !state.manual.capOff.has(x.id)), e.currentTarget));
  $('emptyPaste').addEventListener('click', () => {
    setMode('manual', false);
    setTimeout(() => $('linkInput').focus(), 50);
  });
  $('moreSources').addEventListener('click', () => {
    const b = pickBest();
    if (b) state.selectedId = b.id;
    setMode('manual', false);
  });
  $('historySearch').addEventListener('input', (e) => {
    state.historyQuery = e.target.value;
    renderHistory();
  });
  $('historyFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.historyFilter = b.dataset.value;
    $('historyFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderHistory();
  });
  $('clearHistory').addEventListener('click', (e) =>
    confirmTap(e.currentTarget, 'Tap again to clear', async () => {
      await send({ type: 'avd:history:clear' });
      state.history = [];
      renderHistory();
    })
  );

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[K.state]) {
      state.engine = changes[K.state].newValue || null;
      renderEngine();
    }
    if (area === 'session' && changes[K.shields] && state.tab) {
      const prev = state.shield;
      state.shield = (changes[K.shields].newValue || {})[state.tab.id] || null;
      if (prev && state.shield && state.shield.blocked > prev.blocked) toast('Blocked a pop-up ad');
      renderShield();
      renderRisk();
    }
    if (area === 'local' && changes[K.settings]) {
      state.settings.sketchySites = (changes[K.settings].newValue || {}).sketchySites || [];
      renderSketchyList();
      renderRisk();
    }
    if (area === 'local' && changes[K.history]) {
      state.history = changes[K.history].newValue || [];
      if (state.view === 'history') renderHistory();
    }
  });
}

function showLockdown(site) {
  state.locked = site;
  document.body.classList.add('locked');
  $('lockSite').textContent = site.name;
  $('lockReason').textContent = AVD.unsupportedReason(site);
  $('modeWrap').hidden = true;
  $('rescanBtn').hidden = true;
}

async function init() {
  await loadSettings();
  applyAppearance();
  state.mode = state.settings.mode === 'manual' ? 'manual' : 'auto';

  const tabs = await api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  state.tab = (tabs && tabs[0]) || null;
  const url = (state.tab && state.tab.url) || '';
  state.site = AVD.siteName(url);
  $('siteName').textContent = /^https?:/i.test(url) ? state.site : 'Not a web page';
  if (state.tab && state.tab.favIconUrl && /^(https?|data):/i.test(state.tab.favIconUrl)) $('siteIcon').src = state.tab.favIconUrl;

  initManual();
  wireShell();
  wireManual();
  wireSettings();

  try {
    const st = await api.storage.session.get(K.state);
    state.engine = (st && st[K.state]) || null;
  } catch (e) {
    state.engine = null;
  }
  renderEngine();
  loadHistory();
  if (state.tab) {
    try {
      const d = await api.storage.session.get(K.shields);
      state.shield = ((d && d[K.shields]) || {})[state.tab.id] || null;
    } catch (e) {}
    renderShield();
  }

  const blocked = AVD.matchUnsupported(url);
  if (blocked) {
    showLockdown(blocked);
    state.scanning = false;
    renderDownload();
    return;
  }
  if (!state.tab || !/^(https?|file):/i.test(url)) {
    state.scanning = false;
    renderDownload();
    return;
  }
  scan();
}

init();
