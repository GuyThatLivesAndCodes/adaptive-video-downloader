// Adaptive Video Downloader — shared helpers.
//
// Loaded by every context (service worker via importScripts, Firefox background
// page, offscreen document, popup). Pure functions only — no chrome.* calls.
(function () {
  const KEYS = {
    streams: 'avd:streams', // session: { [tabId]: { [family]: template } }
    media: 'avd:media', //     session: { [tabId]: [ file ] }
    manifests: 'avd:manifests', // session: { [tabId]: [ manifest ] }
    state: 'avd:state', //     session: engine progress snapshot
    history: 'avd:history', // local: [ record ] newest first
    settings: 'avd:settings', // local
  };

  const DEFAULT_SETTINGS = {
    mode: 'auto', //            auto | manual
    theme: 'system', //         system | light | dark
    accent: 'blue', //          blue | purple | pink | orange | green | graphite
    format: 'auto', //          auto | mp4 | original | audio
    keepOriginal: false,
    filenameTemplate: '{title}',
    subfolder: '',
    saveAs: false,
    notify: true,
    badge: true,
    concurrency: 0, //          0 = adaptive, otherwise fixed parallel requests
    retries: 3,
    timeout: 30, //             seconds per request
    delayMs: 0,
    sendReferer: true,
    sendCookies: true,
    onMissing: 'skip', //       skip | stop
    historyLimit: 500,
  };

  // Sites we deliberately don't support: YouTube (throttled DASH + ToS) and
  // DRM-protected services (content is encrypted — can't and won't be bypassed).
  const UNSUPPORTED_SITES = [
    {
      hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
      name: 'YouTube',
      reason:
        'YouTube serves throttled streams that need its obfuscated player code to download, and doing so is against its Terms of Service.',
    },
    { hosts: ['netflix.com'], name: 'Netflix', drm: true },
    { hosts: ['disneyplus.com'], name: 'Disney+', drm: true },
    { hosts: ['hulu.com'], name: 'Hulu', drm: true },
    { hosts: ['max.com', 'hbomax.com'], name: 'Max', drm: true },
    { hosts: ['primevideo.com'], name: 'Prime Video', drm: true },
    { hosts: ['tv.apple.com'], name: 'Apple TV+', drm: true },
    { hosts: ['open.spotify.com', 'spotify.com'], name: 'Spotify', drm: true },
    { hosts: ['peacocktv.com'], name: 'Peacock', drm: true },
    { hosts: ['paramountplus.com'], name: 'Paramount+', drm: true },
  ];

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function siteName(url) {
    return hostnameOf(url).replace(/^www\./, '') || 'this page';
  }

  function matchUnsupported(url) {
    const host = hostnameOf(url);
    if (!host) return null;
    return (
      UNSUPPORTED_SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h))) || null
    );
  }

  function unsupportedReason(site) {
    if (site.reason) return site.reason;
    if (site.drm) {
      return `Video on ${site.name} is protected by DRM (encrypted), so it can't be downloaded — and this extension won't bypass DRM.`;
    }
    return `${site.name} isn't supported.`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '';
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function formatDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  // "1:02:03" | "2:03" | "123" → seconds (NaN when unparsable).
  function parseClock(str) {
    const t = String(str || '').trim();
    if (!t) return NaN;
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return NaN;
    return t.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  }

  function formatSpeed(bps) {
    if (!bps || bps < 1) return '';
    return formatBytes(bps) + '/s';
  }

  // Filename-safe but still human (keeps spaces/unicode, drops reserved chars).
  function sanitizeFilename(name, fallback) {
    let s = String(name || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '');
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s || fallback || 'video';
  }

  function sanitizeFolder(path) {
    return String(path || '')
      .split(/[\\/]+/)
      .map((p) => sanitizeFilename(p, ''))
      .filter((p) => p && p !== '..' && p !== '.')
      .join('/');
  }

  // Strip noise sites append to <title> ("Video name - Site | Watch online").
  function cleanTitle(title, url) {
    let t = String(title || '').trim();
    const host = siteName(url).split('.')[0];
    t = t.replace(/^\(\d+\)\s*/, ''); // "(3) Title" notification counters
    const parts = t.split(/\s+[|\-–—•·]\s+/);
    if (parts.length > 1) {
      const last = parts[parts.length - 1].toLowerCase();
      if (host && last.replace(/[^a-z0-9]/g, '').includes(host.replace(/[^a-z0-9]/g, ''))) parts.pop();
      t = parts.join(' - ');
    }
    return t.trim();
  }

  function applyTemplate(tpl, vars) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const all = {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}-${pad(d.getMinutes())}`,
      ...vars,
    };
    const out = String(tpl || '{title}').replace(/\{(\w+)\}/g, (_, k) => (all[k] != null ? String(all[k]) : ''));
    return sanitizeFilename(out.replace(/\s*[-_]\s*$/, ''), vars.title || 'video');
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function qualityLabel(v) {
    if (!v) return '';
    if (v.height) {
      const fps = v.frameRate && v.frameRate > 31 ? Math.round(v.frameRate) : '';
      return v.height + 'p' + fps;
    }
    if (v.bandwidth) return (v.bandwidth / 1e6).toFixed(1) + ' Mbps';
    return '';
  }

  function bitrateLabel(bps) {
    if (!bps) return '';
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbps';
    return Math.round(bps / 1e3) + ' kbps';
  }

  globalThis.AVD = {
    KEYS,
    DEFAULT_SETTINGS,
    UNSUPPORTED_SITES,
    hostnameOf,
    siteName,
    matchUnsupported,
    unsupportedReason,
    formatBytes,
    formatDuration,
    formatSpeed,
    parseClock,
    sanitizeFilename,
    sanitizeFolder,
    cleanTitle,
    applyTemplate,
    uid,
    qualityLabel,
    bitrateLabel,
  };
})();
