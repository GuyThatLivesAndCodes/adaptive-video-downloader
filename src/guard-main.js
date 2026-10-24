// Adaptive Video Downloader — sketchy-site guard, page world (Chrome).
//
// Runs at document_start in the page's own JS world on sites the user marked
// as sketchy. Pop-up scripts call window.open or click a hidden <a> from code;
// both are refused when they lead to another site. Each block is reported to
// guard.js (isolated world) through a DOM event.
(() => {
  if (window.__avdGuardMain) return;
  window.__avdGuardMain = true;

  // Same registrable-domain approximation as AVD.siteKey (shared.js isn't
  // loaded here so nothing leaks into the page's globals).
  const siteKey = (u) => {
    let host = '';
    try {
      host = new URL(u, location.href).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
    if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
    const p = host.split('.');
    if (p.length <= 2) return host;
    return p.slice(p[p.length - 1].length === 2 && p[p.length - 2].length <= 3 ? -3 : -2).join('.');
  };
  const here = siteKey(location.href);
  const report = (what, url) => document.dispatchEvent(new CustomEvent('avd-guard', { detail: JSON.stringify({ what, url: String(url || '') }) }));

  const open = window.open;
  window.open = function (url) {
    const u = url == null ? '' : String(url);
    if (u && !/^about:/i.test(u) && siteKey(u) === here) return open.apply(this, arguments);
    report('popup', u);
    return null;
  };

  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href && /^https?:/i.test(this.href) && siteKey(this.href) !== here) {
      report('link', this.href);
      return;
    }
    return click.apply(this, arguments);
  };
})();
