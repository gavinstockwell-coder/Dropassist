// Resale value lookup. Uses only official APIs with YOUR keys (StockX Developer Program, eBay Developers Program),
// plus one-click search links for StockX, GOAT, Grailed and eBay sold listings.
// Runs in the background service worker. Keys live in chrome.storage.local; access tokens in chrome.storage.session.
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});

  const ORIGINS = {
    stockx: ['https://api.stockx.com/*', 'https://accounts.stockx.com/*'],
    ebay: ['https://api.ebay.com/*']
  };

  function links(query) {
    const q = encodeURIComponent(query);
    return {
      stockx: `https://stockx.com/search?s=${q}`,
      goat: `https://www.goat.com/search?query=${q}`,
      grailed: `https://www.grailed.com/shop?query=${q}`,
      ebaySold: `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1`
    };
  }

  const median = (arr) => {
    const a = arr.filter((x) => isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };

  async function hasPerm(which) {
    try { return await chrome.permissions.contains({ origins: ORIGINS[which] }); } catch (_) { return false; }
  }

  async function cachedToken(name, fetcher) {
    const k = 'tok_' + name;
    const st = await chrome.storage.session.get(k);
    if (st[k] && st[k].exp > Date.now() + 60000) return st[k].token;
    const { token, ttl } = await fetcher();
    await chrome.storage.session.set({ [k]: { token, exp: Date.now() + (ttl || 3600) * 1000 } });
    return token;
  }

  async function timedFetch(url, opts, ms = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, Object.assign({}, opts, { signal: ctl.signal })); } finally { clearTimeout(t); }
  }

  // ---------- eBay Browse API (active listings; free developer keys) ----------
  async function ebay(keys, query) {
    if (!keys || !keys.clientId || !keys.clientSecret) return { skipped: 'no eBay keys' };
    if (!(await hasPerm('ebay'))) return { skipped: 'eBay access not granted (Options → Resale → Save)' };
    const token = await cachedToken('ebay', async () => {
      const r = await timedFetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${keys.clientId}:${keys.clientSecret}`) },
        body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error(`eBay token: HTTP ${r.status} ${j.error_description || j.error || ''}`.trim());
      return { token: j.access_token, ttl: j.expires_in };
    });
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?limit=50&q=' + encodeURIComponent(query) +
      '&filter=' + encodeURIComponent('buyingOptions:{FIXED_PRICE},priceCurrency:USD');
    const r = await timedFetch(url, { headers: { Authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`eBay search: HTTP ${r.status}`);
    const prices = (j.itemSummaries || []).map((i) => num(i.price && i.price.value)).filter((x) => x != null);
    return { kind: 'asks', count: prices.length, median: median(prices), low: prices.length ? Math.min(...prices) : null, total: j.total || prices.length };
  }

  // ---------- StockX Public API v2 (approved developers; API key + OAuth refresh token) ----------
  async function stockx(keys, query, size) {
    if (!keys || !keys.apiKey || !keys.clientId || !keys.clientSecret || !keys.refreshToken) return { skipped: 'no StockX keys' };
    if (!(await hasPerm('stockx'))) return { skipped: 'StockX access not granted (Options → Resale → Save)' };
    const token = await cachedToken('stockx', async () => {
      const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: keys.clientId, client_secret: keys.clientSecret, audience: 'gateway.stockx.com', refresh_token: keys.refreshToken });
      const r = await timedFetch('https://accounts.stockx.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error(`StockX token: HTTP ${r.status} ${j.error_description || j.error || ''}`.trim());
      return { token: j.access_token, ttl: j.expires_in };
    });
    const h = { 'x-api-key': keys.apiKey, Authorization: 'Bearer ' + token };
    const api = 'https://api.stockx.com/v2';
    const sr = await timedFetch(`${api}/catalog/search?pageSize=5&query=${encodeURIComponent(query)}`, { headers: h });
    const sj = await sr.json().catch(() => ({}));
    if (!sr.ok) throw new Error(`StockX search: HTTP ${sr.status}`);
    const prod = (sj.products || [])[0];
    if (!prod) return { found: false };
    const [vr, mr] = await Promise.all([
      timedFetch(`${api}/catalog/products/${prod.productId}/variants`, { headers: h }),
      timedFetch(`${api}/catalog/products/${prod.productId}/market-data?currencyCode=USD`, { headers: h })
    ]);
    const variants = (await vr.json().catch(() => [])) || [];
    const market = (await mr.json().catch(() => [])) || [];
    const sizeOf = (vid) => { const v = (Array.isArray(variants) ? variants : []).find((x) => x.variantId === vid); return v ? String(v.variantValue || v.sizeChart && v.sizeChart.defaultConversion && v.sizeChart.defaultConversion.size || '') : ''; };
    const rows = (Array.isArray(market) ? market : []).map((m) => ({
      size: sizeOf(m.variantId), ask: num(m.lowestAskAmount), bid: num(m.highestBidAmount),
      last: num(m.lastSaleAmount || m.lastSale && m.lastSale.amount)
    }));
    let pick = null;
    if (size && DA.match) pick = rows.find((r) => r.size && DA.match.sizeKey(r.size) === DA.match.sizeKey(size)) || null;
    return {
      found: true, title: prod.title, url: prod.urlKey ? `https://stockx.com/${prod.urlKey}` : null,
      size: pick ? pick.size : null,
      ask: pick ? pick.ask : median(rows.map((r) => r.ask)), bid: pick ? pick.bid : median(rows.map((r) => r.bid)),
      last: pick ? pick.last : median(rows.map((r) => r.last)), allSizes: !pick
    };
  }

  // query: free text; size: optional ("M"); retail: optional USD number
  async function lookup(query, size, retail) {
    const { resaleKeys = {} } = await chrome.storage.local.get('resaleKeys');
    const wrap = (p) => p.then((v) => v, (e) => ({ error: String((e && e.message) || e) }));
    const [sx, eb] = await Promise.all([wrap(stockx(resaleKeys.stockx, query, size)), wrap(ebay(resaleKeys.ebay, query))]);
    const est = (sx && sx.found && (sx.bid || sx.last)) || (eb && eb.median) || null;
    return { query, size: size || null, retail: retail || null, links: links(query), stockx: sx, ebay: eb, estimate: est, profit: est && retail ? est - retail : null };
  }

  function summary(r) {
    const $ = (n) => (n == null ? '–' : '$' + Math.round(n).toLocaleString('en-US'));
    const parts = [];
    if (r.stockx && r.stockx.found) parts.push(`StockX${r.stockx.size ? ' ' + r.stockx.size : ' (all sizes)'}: ask ${$(r.stockx.ask)} / bid ${$(r.stockx.bid)} / last ${$(r.stockx.last)}`);
    else if (r.stockx && r.stockx.error) parts.push(`StockX error: ${r.stockx.error}`);
    if (r.ebay && r.ebay.count) parts.push(`eBay asks: median ${$(r.ebay.median)}, low ${$(r.ebay.low)} (${r.ebay.count} listings)`);
    else if (r.ebay && r.ebay.error) parts.push(`eBay error: ${r.ebay.error}`);
    if (r.retail) parts.push(`retail ${$(r.retail)}`);
    if (r.profit != null) parts.push(`est. spread ${r.profit >= 0 ? '+' : ''}${$(r.profit)} before fees`);
    if (!parts.length) parts.push('no API keys set — use the links');
    return parts.join(' · ');
  }

  DA.resale = { ORIGINS, links, lookup, summary, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = DA.resale;
})(typeof self !== 'undefined' ? self : globalThis);
