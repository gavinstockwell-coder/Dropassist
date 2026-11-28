// Default settings, profile and an example watchlist item.
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});

  DA.defaults = {
    settings: {
      pollMs: 3000,          // how often to check during the window (never below 1000)
      leadSec: 30,           // start checking this many seconds before drop time
      runMin: 10,            // stop checking this many minutes after drop time
      onlyNew: true,         // ignore products already listed before the drop (scheduled runs only)
      addMethod: 'direct',   // Supreme: 'direct' = same cart request the site's button sends; 'page' = click through product page
      sound: true,
      dropWeekday: 4,        // 0=Sun … 4=Thu
      dropHour: 11,
      dropMinute: 0,
      dropTz: 'America/New_York',
      theme: 'night',        // night | terminal | archive | mono | paper
      font: 'auto',          // auto (theme default) | grotesk | spacemono | plex | sharetech | vt323
      stars: true,
      restockOn: false,      // background restock watcher (alerts only)
      restockMin: 2          // minutes between restock checks (min 1)
    },
    profile: {
      email: '', firstName: '', lastName: '', address1: '', address2: '',
      city: '', state: '', zip: '', phone: '', country: 'US'
    },
    watchlist: [
      {
        id: 'example1', enabled: false, site: 'supreme', label: 'Example – box logo hoodie',
        include: ['box logo', 'hooded'], exclude: ['tee', 'beanie'],
        colors: ['black', 'grey', 'any'], sizes: ['L', 'XL'], url: '', category: '', dropAt: null
      }
    ]
  };

  DA.clampSettings = function clampSettings(s) {
    const d = DA.defaults.settings;
    const n = (v, def, min, max) => { const x = Number(v); return isFinite(x) ? Math.min(max, Math.max(min, x)) : def; };
    return Object.assign({}, d, s, {
      pollMs: n(s && s.pollMs, d.pollMs, 1000, 60000),
      leadSec: n(s && s.leadSec, d.leadSec, 0, 600),
      runMin: n(s && s.runMin, d.runMin, 1, 120),
      dropWeekday: n(s && s.dropWeekday, d.dropWeekday, 0, 6),
      dropHour: n(s && s.dropHour, d.dropHour, 0, 23),
      dropMinute: n(s && s.dropMinute, d.dropMinute, 0, 59),
      restockMin: n(s && s.restockMin, d.restockMin, 1, 60)
    });
  };
})(typeof self !== 'undefined' ? self : globalThis);
