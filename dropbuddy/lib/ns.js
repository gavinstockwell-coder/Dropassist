// Shared namespace + small helpers. Loaded first everywhere (service worker, content scripts, pages, node tests).
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});
  DA.config = DA.config || {};

  DA.sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  // Poll fn() until it returns a truthy value or timeout (ms) passes. Resolves to the value or null.
  DA.waitFor = async function waitFor(fn, timeout = 8000, interval = 100) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = null;
      try { v = await fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() >= end) return null;
      await DA.sleep(interval);
    }
  };

  DA.fmtMs = function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '–';
    return `${Math.round(ms).toLocaleString('en-US')} ms`;
  };

  DA.fmtClock = function fmtClock(t) {
    const d = new Date(t);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };

  DA.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  if (typeof module !== 'undefined' && module.exports) module.exports = DA;
})(typeof self !== 'undefined' ? self : globalThis);
