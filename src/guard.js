// Adaptive Video Downloader — sketchy-site guard, isolated world.
//
// Loaded (after shared.js) at document_start on sites the user marked as
// sketchy, and injected into the open page the moment they mark it.
//   • Click-traps: invisible layers stacked over the page or the player are
//     found and switched off; a click that lands on one is swallowed.
//   • Links to other sites are held back: the first click shows a notice, a
//     second click within 5 s goes through (and tells the background, so its
//     redirect guard and pop-up shield let that one navigation pass).
//   • window.open to other sites is refused (guard-main.js on Chrome; here via
//     Xray wrappers on Firefox).
// Every block is counted on the tab's shield and briefly shown on the page.
(() => {
  if (window.__avdGuard) return;
  window.__avdGuard = true;
  const api = globalThis.browser ?? globalThis.chrome;
  const here = AVD.siteKey(location.href);
  const hostOf = (u) => AVD.hostnameOf(u).replace(/^www\./, '');
  const send = (m) => {
    try {
      const p = api.runtime.sendMessage(m);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  };

  /* ---------- notice ---------- */

  let box = null;
  let hideTimer = null;
  function notice(title, sub) {
    if (!document.documentElement) return;
    if (!box) {
      const host = document.createElement('avd-guard-notice');
      host.style.cssText = 'all:initial;position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML =
        '<style>.n{font:600 13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#fff;background:rgba(28,28,32,.86);' +
        '-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border:.5px solid rgba(255,255,255,.14);border-radius:16px;padding:10px 16px 10px 12px;' +
        'display:flex;gap:10px;align-items:center;box-shadow:0 12px 32px -8px rgba(0,0,0,.5);max-width:420px;opacity:0;transform:translateY(10px);transition:all .3s cubic-bezier(.3,.7,.2,1)}' +
        '.n.on{opacity:1;transform:none}.i{width:26px;height:26px;border-radius:8px;background:linear-gradient(145deg,#34c759,#00a3c4);display:grid;place-items:center;flex:none}' +
        '.i svg{width:15px;height:15px;fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}small{display:block;font-weight:500;font-size:11.5px;opacity:.7;margin-top:1px}</style>' +
        '<div class="n"><div class="i"><svg viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/></svg></div><div><span class="t"></span><small class="s"></small></div></div>';
      document.documentElement.appendChild(host);
      box = { el: root.querySelector('.n'), t: root.querySelector('.t'), s: root.querySelector('.s') };
    }
    box.t.textContent = title;
    box.s.textContent = sub || 'Adaptive is protecting this site';
    requestAnimationFrame(() => box.el.classList.add('on'));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => box.el.classList.remove('on'), 3800);
  }

  function blocked(title, sub) {
    send({ type: 'avd:guard:blocked' });
    notice(title, sub);
  }

  // Reports from guard-main.js (page world).
  document.addEventListener('avd-guard', (e) => {
    let d = {};
    try {
      d = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    const to = d.url && /^https?:/i.test(d.url) ? ' to ' + hostOf(d.url) : '';
    blocked(d.what === 'popup' ? 'Blocked a pop-up' + to : 'Blocked an ad link' + to);
  });

  // Firefox has no page-world script here: patch window.open through Xrays.
  if (window.wrappedJSObject && typeof exportFunction === 'function') {
    try {
      const W = window.wrappedJSObject;
      const open = W.open;
      W.open = exportFunction(function (url) {
        const u = url == null ? '' : String(url);
        let same = false;
        try {
          same = !!u && !/^about:/i.test(u) && AVD.siteKey(new URL(u, location.href).href) === here;
        } catch (err) {}
        if (same) return open.apply(W, arguments);
        blocked('Blocked a pop-up' + (/^https?:/i.test(u) ? ' to ' + hostOf(u) : ''));
        return null;
      }, window);
    } catch (e) {}
  }

  /* ---------- click-traps ---------- */

  function alpha(color) {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return color === 'transparent' ? 0 : 1;
    const p = m[1].split(/[,\s/]+/).filter(Boolean);
    return p.length > 3 ? parseFloat(p[3]) : 1;
  }

  // A layer that belongs to the video player (shares a near ancestor with a
  // <video>) is never a trap — players use transparent click layers too.
  function partOfPlayer(el) {
    let n = el.parentElement;
    for (let i = 0; n && i < 4 && n !== document.body; i++, n = n.parentElement) {
      if (n.querySelector('video')) return true;
    }
    return !!(el.querySelector && el.querySelector('video'));
  }

  function isTrap(el) {
    if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) return false;
    if (el.dataset && el.dataset.avdTrap) return false;
    if (/^(VIDEO|AVD-GUARD-NOTICE)$/.test(el.tagName)) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    const vw = innerWidth || 1;
    const vh = innerHeight || 1;
    const cover = (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
    if (cover < 0.25 || partOfPlayer(el)) return false;
    const opacity = parseFloat(cs.opacity);
    if (el.tagName === 'IFRAME') return opacity < 0.1 || (cs.position === 'fixed' && cover > 0.6);
    const empty = !(el.innerText || '').trim() && !el.querySelector('img,svg,canvas,video,iframe,input,button');
    return opacity < 0.1 || (empty && alpha(cs.backgroundColor) < 0.1 && cs.backgroundImage === 'none');
  }

  function disarm(el) {
    el.dataset.avdTrap = '1';
    el.style.setProperty('pointer-events', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  function sweep() {
    if (!document.body) return;
    const vw = innerWidth;
    const vh = innerHeight;
    const pts = [];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.25, 0.5, 0.75]) pts.push([vw * fx, vh * fy]);
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width > 0) pts.push([r.left + r.width / 2, r.top + r.height / 2]);
    }
    let found = 0;
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > vw || y > vh) continue;
      for (const el of document.elementsFromPoint(x, y)) {
        if (el.tagName === 'VIDEO' || el === document.body || el === document.documentElement) break;
        if (isTrap(el)) {
          disarm(el);
          found++;
        }
      }
    }
    if (found) blocked(`Removed ${found === 1 ? 'a hidden ad layer' : found + ' hidden ad layers'}`, 'Clicks now reach the real page');
  }

  let sweepTimer = null;
  const soon = () => {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, 300);
  };
  const start = () => {
    sweep();
    new MutationObserver(soon).observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    let n = 0;
    const t = setInterval(() => {
      sweep();
      if (++n > 15) clearInterval(t);
    }, 1500);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  /* ---------- clicks ---------- */

  // Ad scripts often fire on mousedown/pointerdown; stop those on traps too.
  const swallowTrap = (e) => {
    if (!e.isTrusted || !isTrap(e.target)) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    disarm(e.target);
    blocked('Blocked a hidden ad layer', 'Click again — it now reaches the real page');
    return true;
  };
  for (const type of ['pointerdown', 'mousedown']) addEventListener(type, swallowTrap, true);

  let pending = null;
  function onClick(e) {
    if (!e.isTrusted) return;
    if (swallowTrap(e)) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !/^https?:/i.test(a.href) || AVD.siteKey(a.href) === here) return;
    if (pending && pending.href === a.href && Date.now() < pending.until) {
      pending = null;
      send({ type: 'avd:guard:allow', url: a.href });
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    pending = { href: a.href, until: Date.now() + 5000 };
    blocked('Blocked a link to ' + hostOf(a.href), 'Click it again within 5 s if you really want to go there');
  }
  addEventListener('click', onClick, true);
  addEventListener('auxclick', onClick, true);
})();
