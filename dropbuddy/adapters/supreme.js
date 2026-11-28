// Supreme adapter. Implements the shared interface used by content/runner.js:
//   pageType, findProducts, snapshot, addToCart (direct), selectVariant, clickAddToCart,
//   goToCheckout, fillCheckout, findPayButton, focusCard, clearCart, cartCount
(function (root) {
  'use strict';
  const DA = root.DA;
  const cfg = DA.config.supreme;
  const S = cfg.selectors;

  function pageType(loc) {
    const p = loc.pathname;
    if (cfg.blockers.queueUrl.test(p)) return 'queue';
    if (/^\/checkouts?(\/|$)/.test(p)) return 'checkout';
    if (/^\/products\//.test(p)) return 'product';
    if (/^\/cart\/?$/.test(p)) return 'cart';
    if (/^\/collections\//.test(p)) return 'listing';
    return 'other';
  }

  function normalize(p) {
    return {
      id: String(p.id),
      title: p.title || '',
      color: p.color || '',
      style: p.style || '',
      handle: p.handle,
      url: (p.url || cfg.productPath(p.handle)).split('?')[0],
      available: !!p.available,
      price: typeof p.price === 'number' ? p.price : null, // cents
      variants: (p.variants || []).map((v) => ({
        id: v.id,
        title: v.title || v.public_title || 'One size',
        available: !!v.available
      }))
    };
  }

  // Reads the product JSON the collection page embeds. One fetch = every product, color and size.
  async function findProducts() {
    let r;
    try {
      r = await fetch(cfg.listingPath, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/html' } });
    } catch (e) {
      return { status: 0, error: 'network error: ' + (e && e.message) };
    }
    if (r.redirected && cfg.blockers.queueUrl.test(new URL(r.url).pathname)) return { blocked: 'queue', url: r.url };
    if (!r.ok) return { status: r.status };
    const html = await r.text();
    const m = html.match(cfg.productsJsonRe);
    if (!m) {
      if (cfg.blockers.queueText.test(html.slice(0, 30000))) return { blocked: 'queue', url: r.url };
      return { status: r.status, error: `products-json not found on ${cfg.listingPath} (site changed? see README → Updating selectors)` };
    }
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { return { status: r.status, error: 'products-json did not parse: ' + e.message }; }
    return { status: 200, products: (data.products || []).map(normalize), total: data.allProductsCount };
  }

  async function snapshot() {
    const r = await findProducts();
    return r.products ? r.products.map((p) => p.id) : null;
  }

  async function cartAdd(variantId) {
    const r = await fetch(cfg.cartAddPath, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ items: [{ id: Number(variantId), quantity: 1 }] })
    });
    let body = null;
    try { body = await r.json(); } catch (_) { /* non-JSON error page */ }
    return { ok: r.ok, status: r.status, message: (body && (body.description || body.message)) || '' };
  }

  // Direct add: the picked size first, then the other sizes from your priority list.
  async function addToCart(pick, log) {
    const tries = [{ id: pick.variantId, title: pick.sizeLabel }].concat(pick.alternates || []);
    for (const v of tries) {
      if (!v.id) continue;
      let res;
      try { res = await cartAdd(v.id); } catch (e) { res = { ok: false, status: 0, message: e.message }; }
      if (res.ok) return { ok: true, size: v.title };
      log(`Add ${pick.title} (${v.title}) failed: HTTP ${res.status} ${res.message}`.trim(), 'warn');
      if (res.status === 0 || res.status === 403 || res.status === 429 || res.status >= 500) return { ok: false, fallbackToPage: true };
      // 422 etc. = that size sold out or hit the order limit → try the next size
    }
    return { ok: false, fallbackToPage: false };
  }

  async function cartCount() {
    try {
      const r = await fetch(cfg.cartPath, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      return (await r.json()).item_count || 0;
    } catch (_) { return null; }
  }

  // Product page: choose the size in the dropdown (option values are variant IDs).
  async function selectVariant(pick, item) {
    const found = await DA.waitFor(() => document.querySelector(S.sizeSelect) || (document.querySelector(S.addToCart) ? 'nosize' : null), 10000);
    if (!found) return { ok: false, retry: true, reason: 'product page has no size picker / add button yet' };
    if (found === 'nosize') return { ok: true, size: pick.sizeLabel || 'one size' };
    const sel = found;
    const opts = [...sel.options].filter((o) => o.value && !o.disabled);
    let opt = opts.find((o) => String(o.value) === String(pick.variantId));
    if (!opt) {
      const want = DA.match.list(item && item.sizes);
      for (const s of want) {
        opt = (s === '*' || DA.match.norm(s) === 'any') ? opts[0] : opts.find((o) => DA.match.sizeKey(o.text) === DA.match.sizeKey(s));
        if (opt) break;
      }
      if (!opt && !want.length) opt = opts[0];
    }
    if (!opt) return { ok: false, retry: true, reason: `none of your sizes in stock (listed: ${opts.map((o) => o.text).join(', ') || 'none'})` };
    if (sel.value !== opt.value) DA.fill.setNativeValue(sel, opt.value);
    return { ok: true, size: opt.text.trim() };
  }

  async function clickAddToCart() {
    const btn = await DA.waitFor(() => document.querySelector(S.addToCart), 5000);
    if (!btn) {
      if (document.querySelector(S.inCartMessage)) return { ok: true, already: true };
      return { ok: false, retry: true, reason: 'add to cart button not found (sold out?)' };
    }
    const before = (await cartCount()) || 0;
    btn.click();
    const ok = await DA.waitFor(async () => document.querySelector(S.inCartMessage) || ((await cartCount()) || 0) > before, 7000, 200);
    return ok ? { ok: true } : { ok: false, reason: 'cart did not update after clicking add to cart', manual: true, button: btn };
  }

  function goToCheckout() { location.assign(cfg.checkoutPath); }

  async function waitForCheckout() {
    return DA.waitFor(() => DA.fill.findField('email', cfg.checkoutFields.find((f) => f.key === 'email'), cfg.checkoutExclude), 15000, 200);
  }

  function findPayButton() {
    for (const s of S.payButton) {
      const el = document.querySelector(s);
      if (el && DA.fill.isVisible(el)) return el;
    }
    return null;
  }

  function focusCard() {
    const f = document.querySelector(S.cardNumberFrame);
    if (f) { f.scrollIntoView({ block: 'center' }); try { f.focus(); } catch (_) { /* cross-origin frame */ } }
    return !!f;
  }

  async function clearCart() {
    const r = await fetch(cfg.cartClearPath, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return r.ok;
  }

  DA.adapter = {
    cfg, pageType, findProducts, snapshot, addToCart, cartCount, selectVariant, clickAddToCart,
    goToCheckout, waitForCheckout, findPayButton, focusCard, clearCart,
    listingPath: cfg.listingPath
  };
})(typeof self !== 'undefined' ? self : globalThis);
