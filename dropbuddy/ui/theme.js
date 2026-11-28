// Applies the chosen theme/font before first paint (cached in localStorage), then confirms from storage.
(function () {
  'use strict';
  const el = document.documentElement;
  const apply = (t, f, stars) => {
    el.dataset.theme = t || 'night';
    if (f && f !== 'auto') el.dataset.font = f; else delete el.dataset.font;
    el.dataset.stars = stars === false ? 'off' : 'on';
  };
  try { const c = JSON.parse(localStorage.getItem('db-look') || 'null'); if (c) apply(c.theme, c.font, c.stars); } catch (_) { /* first run */ }
  const sync = () => chrome.storage.local.get('settings').then(({ settings = {} }) => {
    apply(settings.theme, settings.font, settings.stars);
    try { localStorage.setItem('db-look', JSON.stringify({ theme: settings.theme, font: settings.font, stars: settings.stars })); } catch (_) { /* ignore */ }
    window.dispatchEvent(new Event('db-theme'));
  });
  sync();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) sync(); });
})();
