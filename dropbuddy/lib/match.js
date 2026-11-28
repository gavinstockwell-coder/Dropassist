// Pure matching logic: keywords, colors and sizes in priority order. No DOM, no chrome.* — unit tested in tests/.
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[®™©]/g, '')
      .replace(/[^a-z0-9.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Whole-word / whole-phrase match on normalized text.
  function hasTerm(textNorm, term) {
    const t = norm(term);
    if (!t) return true;
    return (' ' + textNorm + ' ').includes(' ' + t + ' ');
  }

  function list(v) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  }

  const SIZE_ALIASES = {
    xs: ['xs', 'xsmall', 'x small', 'extra small'],
    s: ['s', 'small', 'sm'],
    m: ['m', 'medium', 'md', 'med'],
    l: ['l', 'large', 'lg'],
    xl: ['xl', 'xlarge', 'x large', 'extra large'],
    xxl: ['xxl', 'xxlarge', 'xx large', '2xl'],
    xxxl: ['xxxl', 'xxxlarge', 'xxx large', '3xl'],
    os: ['os', 'o s', 'one size', 'onesize', 'n a', 'na', 'default title']
  };
  const ALIAS_TO_KEY = {};
  for (const [k, arr] of Object.entries(SIZE_ALIASES)) for (const a of arr) ALIAS_TO_KEY[a] = k;

  function sizeKey(s) {
    let n = norm(s).replace(/^(us|size|sz)\s+/, '').replace(/-/g, ' ').trim();
    if (ALIAS_TO_KEY[n]) return ALIAS_TO_KEY[n];
    const compact = n.replace(/\s+/g, '');
    if (ALIAS_TO_KEY[compact]) return ALIAS_TO_KEY[compact];
    return compact; // numeric sizes like "10.5", "32", or anything else, compared exactly
  }

  const isWildcard = (x) => x === '*' || norm(x) === 'any';

  // -1 = color not wanted; otherwise priority index (lower is better).
  function colorRank(color, colors) {
    const want = list(colors);
    if (!want.length) return 0;
    const c = norm(color);
    for (let i = 0; i < want.length; i++) {
      if (isWildcard(want[i])) return i;
      if (c && hasTerm(c, want[i])) return i;
    }
    return -1;
  }

  // Choose the first available variant following size priority. Returns { variant, alternates, reason }.
  function pickVariant(variants, sizes) {
    const vs = (variants || []).filter(Boolean);
    const avail = vs.filter((v) => v.available !== false);
    if (!avail.length) return { variant: null, alternates: [], reason: 'sold out' };
    if (vs.length === 1) return { variant: avail[0], alternates: [], reason: 'single variant' };
    const want = list(sizes);
    if (!want.length) return { variant: avail[0], alternates: avail.slice(1), reason: 'first available size' };
    const ordered = [];
    for (const s of want) {
      if (isWildcard(s)) { for (const v of avail) if (!ordered.includes(v)) ordered.push(v); continue; }
      const k = sizeKey(s);
      for (const v of avail) if (sizeKey(v.title) === k && !ordered.includes(v)) ordered.push(v);
    }
    if (!ordered.length) {
      return { variant: null, alternates: [], reason: `sold out in your sizes (available: ${avail.map((v) => v.title).join(', ')})` };
    }
    return { variant: ordered[0], alternates: ordered.slice(1), reason: 'size priority' };
  }

  function urlPath(u) {
    try { return new URL(u, 'https://x.invalid').pathname.replace(/\/+$/, '').toLowerCase(); } catch (_) { return String(u || '').toLowerCase(); }
  }

  // Evaluate one product against one watchlist item.
  // ctx: { baseline: Set<id>|Array, onlyNew: bool }
  function evaluate(product, item, ctx) {
    ctx = ctx || {};
    const include = list(item.include);
    const exclude = list(item.exclude);
    const text = norm([product.title, product.color, product.style].filter(Boolean).join(' '));

    let candidate;
    if (item.url) {
      candidate = urlPath(product.url) === urlPath(item.url);
      if (!candidate) return { ok: false, candidate: false, reason: 'different product URL' };
    } else {
      candidate = include.length === 0 || include.some((t) => hasTerm(text, t));
      for (const t of include) if (!hasTerm(text, t)) return { ok: false, candidate, reason: `missing keyword "${t}"` };
      for (const t of exclude) if (hasTerm(text, t)) return { ok: false, candidate, reason: `excluded keyword "${t}"` };
    }

    const baseline = ctx.baseline instanceof Set ? ctx.baseline : new Set(ctx.baseline || []);
    // A pasted product URL is an explicit choice, so the old-stock filter only applies to keyword items.
    if (!item.url && ctx.onlyNew && baseline.size && baseline.has(String(product.id))) {
      return { ok: false, candidate, reason: 'was already listed before the drop (old stock)' };
    }

    const rank = product.color == null || product.color === '' ? 0 : colorRank(product.color, item.colors);
    if (rank < 0) return { ok: false, candidate, reason: `color "${product.color}" not in your list` };

    if (product.variants == null) {
      // Sizes are only known on the product page (no variant data). Decide there.
      return { ok: true, candidate, colorRank: rank, variant: null, alternates: [], needsPage: true, reason: 'match (size picked on product page)' };
    }
    const pv = pickVariant(product.variants, item.sizes);
    if (!pv.variant) return { ok: false, candidate, reason: pv.reason };
    return { ok: true, candidate, colorRank: rank, variant: pv.variant, alternates: pv.alternates, needsPage: false, reason: `match → ${product.color ? product.color + ' / ' : ''}${pv.variant.title}` };
  }

  // Decide what to buy this poll. Items are in priority order; one product per item, never the same product twice.
  // Returns { picks, decisions } where decisions cover "candidate" products only (keyword hit or URL hit).
  function planPicks(products, items, ctx) {
    ctx = ctx || {};
    const done = new Set(ctx.doneItemIds || []);
    const used = new Set();
    const picks = [];
    const decisions = [];
    for (const item of items || []) {
      if (!item || item.enabled === false || done.has(item.id)) continue;
      const ok = [];
      (products || []).forEach((p, idx) => {
        const r = evaluate(p, item, ctx);
        // "Match anything" items (no keywords, no URL) would make every product a candidate; only log their hits.
        const noisy = !item.url && !list(item.include).length;
        if (r.candidate && (r.ok || !noisy)) decisions.push({ itemId: item.id, productId: String(p.id), title: p.title, color: p.color || '', ok: r.ok, reason: r.reason });
        if (r.ok && !used.has(String(p.id))) ok.push({ p, r, idx });
      });
      if (!ok.length) continue;
      ok.sort((a, b) => a.r.colorRank - b.r.colorRank || a.idx - b.idx);
      const { p, r } = ok[0];
      used.add(String(p.id));
      picks.push({
        itemId: item.id,
        productId: String(p.id),
        title: p.title,
        color: p.color || '',
        url: p.url,
        price: p.price == null ? null : p.price,
        handle: p.handle || null,
        variantId: r.variant ? r.variant.id : null,
        sizeLabel: r.variant ? r.variant.title : null,
        alternates: (r.alternates || []).map((v) => ({ id: v.id, title: v.title })),
        needsPage: !!r.needsPage
      });
    }
    return { picks, decisions };
  }

  const STOP = new Set(['supreme', 'the', 'and', 'with', 'of', 'for', 'a', 'an', 'in', 'on', 'x']);
  // "Supreme®/Schott® Hooded Shearling Coat" → ["schott", "hooded", "shearling", "coat"]
  function keywordsFromTitle(title) {
    const out = [];
    for (const w of norm(title).split(' ')) {
      if (!w || STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
      if (!out.includes(w)) out.push(w);
    }
    return out;
  }

  DA.match = { keywordsFromTitle, norm, hasTerm, list, sizeKey, colorRank, pickVariant, evaluate, planPicks, urlPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = DA.match;
})(typeof self !== 'undefined' ? self : globalThis);
