// Runs inside Shopify's secure card iframes on Supreme checkout. Each iframe shows one field. When the checkout tab asks, this frame requests just
// its own field's value from the background, which only answers for a checkout tab with the vault unlocked.
(function (root) {
  'use strict';
  const DA = root.DA;
  if (!DA || !DA.fill || DA.__cardFrame) return;
  DA.__cardFrame = true;

  // Which card field this frame holds, from the visible input.
  const FIELDS = [
    { field: 'number', sel: 'input[autocomplete="cc-number"]' },
    { field: 'exp', sel: 'input[autocomplete="cc-exp"]' },
    { field: 'cvv', sel: 'input[autocomplete="cc-csc"]' },
    { field: 'name', sel: 'input[autocomplete="cc-name"]' }
  ];
  function myField() {
    for (const f of FIELDS) for (const el of document.querySelectorAll(f.sel)) if (DA.fill.isVisible(el)) return { field: f.field, el };
    return null;
  }

  let busy = false;
  async function fill() {
    if (busy) return;
    busy = true;
    try {
      const me = await DA.waitFor(myField, 5000, 150);
      if (!me || me.el.value) return;
      const res = await new Promise((r) => {
        try { chrome.runtime.sendMessage({ type: 'cardField', field: me.field }, (x) => { void chrome.runtime.lastError; r(x); }); } catch (_) { r(null); }
      });
      if (!res || res.value == null || res.value === '') return;
      me.el.focus();
      DA.fill.setNativeValue(me.el, res.value);
      me.el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      me.el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      me.el.blur();
    } finally { busy = false; }
  }

  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'cardFillNow') fill(); return false; });
  fill(); // in case the checkout already asked before this frame loaded
})(typeof self !== 'undefined' ? self : globalThis);
