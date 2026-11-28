// Drop-time math in a named time zone (default America/New_York), DST-safe, no libraries.
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});

  const fmtCache = new Map();
  function formatter(timeZone) {
    if (!fmtCache.has(timeZone)) {
      fmtCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }));
    }
    return fmtCache.get(timeZone);
  }

  // Wall-clock parts of an instant in a time zone.
  function wallParts(instantMs, timeZone) {
    const parts = {};
    for (const p of formatter(timeZone).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
    const y = +parts.year, mo = +parts.month, d = +parts.day;
    return {
      y, mo, d, h: +parts.hour, mi: +parts.minute, s: +parts.second,
      weekday: new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
    };
  }

  // (wall time in tz) - (UTC) at an instant, in ms.
  function tzOffsetMs(instantMs, timeZone) {
    const p = wallParts(instantMs, timeZone);
    const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    return asUTC - Math.floor(instantMs / 1000) * 1000;
  }

  // Epoch ms for a wall-clock time in a time zone.
  function zonedToEpoch(y, mo, d, h, mi, timeZone) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    const off1 = tzOffsetMs(guess, timeZone);
    let t = guess - off1;
    const off2 = tzOffsetMs(t, timeZone);
    if (off2 !== off1) t = guess - off2;
    return t;
  }

  // Next weekly drop at weekday (0=Sun..6=Sat) hour:minute in timeZone.
  // A drop that started less than graceMs ago still counts as "next" (so arming mid-window works).
  function nextWeeklyDrop(nowMs, opts) {
    const o = Object.assign({ weekday: 4, hour: 11, minute: 0, timeZone: 'America/New_York', graceMs: 0 }, opts || {});
    const today = wallParts(nowMs, o.timeZone);
    for (let add = 0; add <= 8; add++) {
      const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + add));
      if (day.getUTCDay() !== o.weekday) continue;
      const t = zonedToEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), o.hour, o.minute, o.timeZone);
      if (t > nowMs - o.graceMs) return t;
    }
    throw new Error('nextWeeklyDrop: no candidate found');
  }

  function formatCountdown(ms) {
    if (ms == null || !isFinite(ms)) return '–';
    const neg = ms < 0;
    let s = Math.abs(ms) / 1000;
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const p = (n) => String(n).padStart(2, '0');
    const sec = s.toFixed(1).padStart(4, '0');
    return `${neg ? '-' : ''}${d ? d + 'd ' : ''}${p(h)}:${p(m)}:${sec}`;
  }

  function formatInZone(ms, timeZone) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    }).format(new Date(ms));
  }

  DA.time = { wallParts, tzOffsetMs, zonedToEpoch, nextWeeklyDrop, formatCountdown, formatInZone };
  if (typeof module !== 'undefined' && module.exports) module.exports = DA.time;
})(typeof self !== 'undefined' ? self : globalThis);
