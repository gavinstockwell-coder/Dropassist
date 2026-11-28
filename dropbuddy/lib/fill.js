// DOM helpers for content scripts: filling React/Vue-controlled fields, finding checkout fields, detecting queues/CAPTCHAs.
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});

  const US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    PR: 'Puerto Rico'
  };

  // Profile key -> autocomplete token used as a site-independent fallback.
  const AUTOCOMPLETE = {
    email: ['email'],
    firstName: ['given-name'],
    lastName: ['family-name'],
    address1: ['address-line1', 'street-address'],
    address2: ['address-line2'],
    city: ['address-level2'],
    state: ['address-level1'],
    zip: ['postal-code'],
    phone: ['tel', 'tel-national'],
    country: ['country', 'country-name']
  };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05;
  }

  function usable(el, exclude) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.type === 'hidden') return false;
    if (exclude && el.matches(exclude)) return false;
    return isVisible(el);
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function chooseOption(select, wanted) {
    const w = String(wanted || '').trim();
    if (!w) return null;
    const lw = w.toLowerCase();
    const full = US_STATES[w.toUpperCase()];
    const opts = [...select.options];
    return opts.find((o) => o.value === w) ||
      opts.find((o) => o.value.toLowerCase() === lw) ||
      opts.find((o) => o.text.trim().toLowerCase() === lw) ||
      (full && opts.find((o) => o.text.trim().toLowerCase() === full.toLowerCase())) ||
      (w.length === 2 && opts.find((o) => o.value.toUpperCase().endsWith('-' + w.toUpperCase()))) ||
      null;
  }

  // Fill a single element. Returns true when the value took.
  function fillElement(el, value) {
    if (value == null || value === '') return false;
    if (el instanceof HTMLSelectElement) {
      const opt = chooseOption(el, value);
      if (!opt) return false;
      if (el.value === opt.value) return true;
      el.focus();
      setNativeValue(el, opt.value);
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return el.value === opt.value;
    }
    if (el.value === String(value)) return true;
    el.focus();
    setNativeValue(el, String(value));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // closes address suggestion popups
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.blur();
    return true;
  }

  function findField(key, def, exclude) {
    const sels = (def && def.selectors) || [];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) if (usable(el, exclude)) return el;
    }
    const tokens = (def && def.autocomplete) || AUTOCOMPLETE[key] || [];
    if (tokens.length) {
      for (const el of document.querySelectorAll('input, select, textarea')) {
        if (!usable(el, exclude)) continue;
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
        if (tokens.some((t) => ac.includes(t))) return el;
      }
    }
    return null;
  }

  function profileValue(key, profile) {
    const v = profile[key];
    if (key === 'phone') return String(v || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
    if (key === 'state') return String(v || '').trim().toUpperCase();
    return v;
  }

  // Fill every field we can find. Each element is touched at most once (opts.touched WeakSet), so
  // anything you change by hand afterwards is never overwritten.
  // fields: [{ key, selectors?, autocomplete?, waitAfterMs?, optional? }] in fill order.
  async function fillProfile(fields, profile, opts) {
    opts = opts || {};
    const touched = opts.touched || new WeakSet();
    const filled = [], missing = [], skipped = [];
    for (const f of fields) {
      const val = profileValue(f.key, profile);
      if (val == null || val === '') { skipped.push(f.key); continue; }
      const el = findField(f.key, f, opts.exclude);
      if (!el) { (f.optional ? skipped : missing).push(f.key); continue; }
      if (touched.has(el)) { filled.push(f.key); continue; }
      touched.add(el);
      const already = el instanceof HTMLSelectElement ? (chooseOption(el, val) || {}).value === el.value : el.value === String(val);
      if (already) { filled.push(f.key); continue; }
      const ok = fillElement(el, val);
      (ok ? filled : missing).push(f.key);
      if (f.waitAfterMs) await DA.sleep(f.waitAfterMs);
    }
    return { filled, missing, skipped };
  }

  // Queue / waiting room / CAPTCHA detection. Returns 'queue' | 'captcha' | null.
  function detectBlocker(cfg) {
    const b = (cfg && cfg.blockers) || {};
    const path = location.pathname + location.search;
    if (b.queueUrl && b.queueUrl.test(path)) return 'queue';
    for (const sel of b.captchaSelectors || []) {
      for (const el of document.querySelectorAll(sel)) if (isVisible(el) && el.getBoundingClientRect().height > 40) return 'captcha';
    }
    if (b.queueText) {
      const h = [...document.querySelectorAll('h1, h2, [role="heading"]')].slice(0, 8).map((e) => e.textContent).join(' ');
      if (b.queueText.test(h)) return 'queue';
    }
    return null;
  }

  // Keep refilling empty fields that appear later (multi-step checkouts, re-rendered forms).
  function watchAndFill(fields, profile, opts, onFill) {
    opts = Object.assign({}, opts);
    opts.touched = opts.touched || new WeakSet();
    let timer = null, stopped = false, busy = false;
    const run = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const r = await fillProfile(fields, profile, opts);
        if (onFill) onFill(r);
      } finally { busy = false; }
    };
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(run, 250); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    const stopAt = setTimeout(() => stop(), (opts && opts.watchMs) || 10 * 60 * 1000);
    function stop() { stopped = true; mo.disconnect(); clearTimeout(timer); clearTimeout(stopAt); }
    return stop;
  }

  DA.fill = { US_STATES, AUTOCOMPLETE, isVisible, setNativeValue, chooseOption, fillElement, findField, fillProfile, detectBlocker, watchAndFill };
})(typeof self !== 'undefined' ? self : globalThis);
