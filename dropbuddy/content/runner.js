// Content-script state machine. Runs on every Supreme page; only acts on the tab the background
// marked as the "run tab". Phases (stored by the background so they survive page navigations):
//   armed → monitoring → carting → [manual] → checkout → ready      (+ paused / stopped)
(function (root) {
  'use strict';
  const DA = root.DA;
  if (!DA || !DA.adapter || DA.__runnerLoaded) return;
  DA.__runnerLoaded = true;

  const A = DA.adapter;
  const cfg = A.cfg;
  const ui = DA.ui;

  let ctx = null;            // { isRunTab, run, settings, profile, items }
  let gen = 0;               // bumped on every route(); stale loops exit
  let stopFill = null;
  const touched = new WeakSet();

  // ---------- messaging ----------
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || null); });
      } catch (_) { resolve(null); } // extension was reloaded; this page's script is orphaned
    });
  }
  const log = (msg, lvl) => send({ type: 'log', lvl: lvl || 'info', site: cfg.id, msg });
  const run = () => (ctx && ctx.run) || null;
  const serverNow = () => Date.now() + ((run() && run().offsetMs) || 0);

  async function setPhase(phase, patch, note, lvl) {
    const res = await send({ type: 'phase', phase, patch: patch || {}, note, lvl });
    if (res && res.run && ctx) ctx.run = res.run;
    return run();
  }

  async function sleepUntilServer(t, my) {
    while (my === gen) {
      const left = t - serverNow();
      if (left <= 0) return true;
      await DA.sleep(Math.min(left, 250));
    }
    return false;
  }

  // ---------- banner helpers ----------
  function opts(extra) {
    const r = run() || {};
    const mode = r.mode === 'scheduled' ? 'ARMED' : r.mode === 'now' ? 'LIVE' : '';
    return Object.assign({ dry: !!r.dryRun, mode }, extra || {});
  }
  const stopBtn = { label: 'Stop run', onClick: () => send({ type: 'stopRun', reason: 'Stopped from the page banner' }) };

  function timingText(r) {
    const m = r.marks || {};
    const base = r.mode === 'scheduled' ? r.dropAt - (r.offsetMs || 0) : m.monitor;
    const parts = [];
    if (m.match && base) parts.push(`${r.mode === 'scheduled' ? 'drop' : 'start'}→match ${DA.fmtMs(m.match - base)}`);
    if (m.atc && m.match) parts.push(`match→cart ${DA.fmtMs(m.atc - m.match)}`);
    if (m.ready && m.atc) parts.push(`cart→checkout ready ${DA.fmtMs(m.ready - m.atc)}`);
    if (m.ready && base) parts.push(`total ${DA.fmtMs(m.ready - base)}`);
    return parts.join(' · ');
  }

  // ---------- entry ----------
  async function refresh() {
    const res = await send({ type: 'hello', url: location.href });
    if (!res) return;
    ctx = res;
    if (ui.setTheme && ctx.settings) ui.setTheme(ctx.settings.theme, ctx.settings.font);
    route();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen') return false;
    if (msg.type === 'runChanged') { refresh(); return false; }
    if (msg.type === 'beep') { ui.beep(msg.kind); return false; }
    if (msg.type === 'ping') { sendResponse({ ok: true, site: cfg.id, page: A.pageType(location) }); return false; }
    if (msg.type === 'fillNow') { manualFill().then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) })); return true; }
    return false;
  });

  async function route() {
    const my = ++gen;
    const r = run();
    if (!ctx || !ctx.isRunTab || !r || !r.active) {
      if (r && r.phase === 'stopped' && ctx && ctx.isRunTab) ui.banner.show('Run stopped', opts({ tone: 'warn', sub: r.note || '' }));
      else ui.banner.hide();
      return;
    }
    if (await blockerGate(my)) return;
    const page = A.pageType(location);
    try {
      switch (r.phase) {
        case 'scheduled':
        case 'armed': return await armed(my);
        case 'monitoring': return await monitor(my);
        case 'carting': return await carting(my, page);
        case 'manual': return await manual(my);
        case 'checkout': return await checkout(my, page);
        case 'ready': return await ready(my, page);
        case 'paused':
          ui.banner.show('Paused', opts({ tone: 'warn', sub: r.note || '', buttons: [{ label: 'Resume', onClick: () => send({ type: 'resume' }) }, stopBtn] }));
          return;
        default: ui.banner.hide();
      }
    } catch (e) {
      const m = String((e && e.message) || e);
      log(`Error during ${r.phase}: ${m}`, 'error');
      ui.banner.show('Something broke — see the log', opts({ tone: 'err', sub: m, buttons: [stopBtn] }));
    }
  }

  // ---------- queue / CAPTCHA ----------
  async function blockerGate(my) {
    const kind = DA.fill.detectBlocker(cfg);
    if (!kind) return false;
    send({ type: 'blocked', kind, url: location.href });
    ui.banner.show(kind === 'captcha' ? 'CAPTCHA — solve it yourself' : 'In the queue — hang tight',
      opts({ tone: 'warn', sub: 'Automation is paused and picks up again by itself once this clears.', buttons: [stopBtn] }));
    await DA.waitFor(() => my !== gen || !DA.fill.detectBlocker(cfg), 60 * 60 * 1000, 500);
    if (my !== gen) return true;
    await send({ type: 'unblocked', kind });
    await DA.sleep(400);
    if (my === gen) route(); // same document (overlay CAPTCHA) → carry on; navigations restart the script anyway
    return true;
  }

  // ---------- phases ----------
  async function armed(my) {
    let r = run();
    if (r.phase === 'scheduled') r = await setPhase('armed', {}, null);
    ui.banner.show('Armed — waiting for the drop', opts({
      sub: `${ctx.items.length} item(s) · checks every ${ctx.settings.pollMs} ms from ${ctx.settings.leadSec}s before drop`,
      buttons: [stopBtn]
    }));
    ui.banner.countdown(() => r.dropAt - serverNow());

    if (r.onlyNew && A.snapshot && !r.baseline) {
      if (serverNow() < r.dropAt - 3000) {
        if (!(await sleepUntilServer(Math.min(r.startAt, r.dropAt) - 10000, my))) return;
        const ids = await A.snapshot(ctx);
        if (my !== gen) return;
        if (ids) r = await setPhase('armed', { baseline: ids }, `Baseline: ${ids.length} product(s) already listed — they'll be ignored as old stock`);
        else log('Could not take the pre-drop snapshot; old-stock filter is off for this run', 'warn');
      } else {
        log('Armed after drop time — old-stock filter is off for this run', 'warn');
      }
    }
    if (!(await sleepUntilServer(r.startAt, my))) return;
    await setPhase('monitoring', {}, 'Monitoring started');
    if (my === gen) route();
  }

  async function monitor(my) {
    const r = run();
    const s = ctx.settings;
    const base = Math.max(1000, Number(s.pollMs) || 3000);
    const baseline = new Set(r.baseline || []);
    const lastReason = new Map();
    let interval = base, n = 0;

    ui.banner.show('Monitoring…', opts({ sub: `Checking every ${base} ms`, buttons: [stopBtn] }));
    if (r.mode === 'scheduled') ui.banner.countdown(() => r.dropAt - serverNow());

    while (my === gen) {
      if (serverNow() > r.stopAt) {
        await setPhase('stopped', {}, 'Monitoring window ended with no match', 'warn');
        ui.banner.show('Stopped — window ended, nothing matched', opts({ tone: 'warn' }));
        return;
      }
      if (DA.fill.detectBlocker(cfg)) { route(); return; }
      const t0 = Date.now();
      let res;
      try { res = await A.findProducts(ctx); } catch (e) { res = { status: 0, error: String((e && e.message) || e) }; }
      if (my !== gen) return;

      if (res.blocked) {
        log(`Site sent a ${res.blocked} page — opening it so you can see it`, 'warn');
        location.assign(res.url || '/');
        return;
      }
      if (res.products) {
        interval = base;
        n++;
        const pending = ctx.items.filter((it) => !(run().doneItemIds || []).includes(it.id));
        const { picks, decisions } = DA.match.planPicks(res.products, pending, { baseline, onlyNew: !!r.onlyNew && baseline.size > 0 });
        for (const d of decisions.slice(0, 40)) {
          const k = d.itemId + '|' + d.productId;
          if (lastReason.get(k) === d.reason) continue;
          lastReason.set(k, d.reason);
          log(`${d.ok ? 'MATCH' : 'skip'} · ${d.title}${d.color ? ' – ' + d.color : ''}: ${d.reason}`, d.ok ? 'ok' : 'info');
        }
        if (n === 1 || n % 20 === 0) log(`Check #${n}: ${res.products.length} products, ${picks.length} match(es)`);
        ui.banner.sub(`Check #${n} · ${res.products.length} products · ${new Date().toLocaleTimeString()}`);
        if (picks.length) {
          await send({ type: 'mark', name: 'match' });
          await setPhase('carting', { picks }, `Matched: ${picks.map((p) => p.title + (p.color ? ' – ' + p.color : '') + (p.sizeLabel ? ' / ' + p.sizeLabel : '')).join('; ')}`, 'ok');
          if (my === gen) route();
          return;
        }
      } else if (res.status === 403) {
        await setPhase('paused', { resumePhase: 'monitoring' }, "Site answered 403 (bot protection). Paused so we don't keep hitting it — reload the page yourself, then press Resume.", 'error');
        if (my === gen) route();
        return;
      } else {
        interval = Math.min(interval * 2, 30000);
        log(`Check failed (${res.status ? 'HTTP ' + res.status : ''}${res.error ? ' ' + res.error : ''}). Next try in ${interval} ms`, 'warn');
      }
      await DA.sleep(Math.max(0, interval - (Date.now() - t0)));
    }
  }

  async function recordAdded(p, size) {
    const r = run();
    if (!(r.marks && r.marks.atc)) await send({ type: 'mark', name: 'atc' });
    await setPhase('carting', {
      carted: (r.carted || []).concat([{ itemId: p.itemId, productId: p.productId, title: p.title, color: p.color || '', size: size || '', price: p.price == null ? null : p.price }]),
      doneItemIds: (r.doneItemIds || []).concat([p.itemId])
    }, `Added to cart: ${p.title}${p.color ? ' – ' + p.color : ''}${size ? ' / ' + size : ''}`, 'ok');
  }

  async function carting(my, page) {
    const s = ctx.settings;
    let queue = (run().picks || []).slice();
    ui.banner.show('Adding to cart…', opts({
      sub: queue.map((p) => `${p.title}${p.color ? ' – ' + p.color : ''}${p.sizeLabel ? ' / ' + p.sizeLabel : ''}`).join('\n'),
      buttons: [stopBtn]
    }));

    // 1) Direct adds (Supreme): no page loads at all.
    if (A.addToCart && s.addMethod !== 'page' && queue.some((p) => p.variantId && !p.viaPage)) {
      const rest = [];
      for (const p of queue) {
        if (!p.variantId || p.viaPage) { rest.push(p); continue; }
        const res = await A.addToCart(p, log);
        if (my !== gen) return;
        if (res.ok) await recordAdded(p, res.size);
        else if (res.fallbackToPage) rest.push(Object.assign({}, p, { viaPage: true }));
        else log(`${p.title}: sold out before it could be added — still watching for it`, 'warn');
      }
      queue = rest;
      await setPhase('carting', { picks: queue });
    }

    // 2) Product-page adds (Supreme fallback). One pick at a time; navigation resumes here.
    while (queue.length && my === gen) {
      const p = queue[0];
      const item = ctx.items.find((i) => i.id === p.itemId) || {};
      const here = page === 'product' && DA.match.urlPath(location.href) === DA.match.urlPath(p.url);
      if (!here) { location.assign(p.url); return; }

      const sel = await A.selectVariant(p, item);
      if (my !== gen) return;
      let add = null;
      if (sel.ok) {
        add = await A.clickAddToCart();
        if (my !== gen) return;
      }
      const problem = !sel.ok ? sel : (!add.ok ? add : null);

      if (!problem) {
        await recordAdded(p, [sel.color, sel.size].filter(Boolean).join(' / '));
        queue.shift();
        await setPhase('carting', { picks: queue });
        continue;
      }
      if (problem.retry && serverNow() < run().stopAt) {
        const wait = Math.max(1000, Number(s.pollMs) || 3000);
        ui.banner.show('Waiting for stock…', opts({ sub: `${p.title}: ${problem.reason}\nReloading in ${wait} ms`, buttons: [stopBtn] }));
        if (run().lastWaitReason !== problem.reason) await setPhase('carting', { lastWaitReason: problem.reason }, `${p.title}: ${problem.reason} — reloading until it's live`);
        await DA.sleep(wait);
        if (my === gen) location.reload();
        return;
      }
      if (problem.manual) {
        await setPhase('manual', { picks: queue }, `${p.title}: ${problem.reason}. Your turn — click Add to Cart.`, 'warn');
        if (my === gen) route();
        return;
      }
      log(`${p.title}: ${problem.reason} — skipping`, 'warn');
      queue.shift();
      await setPhase('carting', { picks: queue });
    }
    if (my !== gen) return;

    const r = run();
    if ((r.carted || []).length) {
      await setPhase('checkout', { picks: [] }, `Cart ready (${r.carted.length} item(s)) → checkout`);
      if (my === gen) route();
      return;
    }
    const left = ctx.items.filter((i) => !(r.doneItemIds || []).includes(i.id));
    if (left.length && serverNow() < r.stopAt) {
      await setPhase('monitoring', { picks: [] }, 'Nothing was added — back to monitoring');
      if (my === gen) route();
      return;
    }
    await setPhase('stopped', { picks: [] }, 'Nothing could be added to the cart', 'warn');
    if (my === gen) route();
  }

  // Fallback when the automated click is rejected: you click, we watch the cart count and continue.
  async function manual(my) {
    const r = run();
    const p = (r.picks || [])[0];
    const btn = document.querySelector(cfg.selectors.addToCart);
    if (btn) ui.highlight(btn);
    const proceed = async () => {
      const cur = run();
      const pk = (cur.picks || [])[0];
      if (!(cur.marks && cur.marks.atc)) await send({ type: 'mark', name: 'atc' });
      await setPhase('carting', {
        picks: (cur.picks || []).slice(1),
        carted: (cur.carted || []).concat([{ itemId: pk ? pk.itemId : null, title: pk ? pk.title : 'item', size: '(picked by you)' }]),
        doneItemIds: (cur.doneItemIds || []).concat(pk ? [pk.itemId] : [])
      }, 'You added it — continuing', 'ok');
      route();
    };
    ui.banner.show('Your turn: click Add to Cart', opts({
      tone: 'warn',
      sub: `${p ? p.title + '\n' : ''}The site didn't take the automated click. Pick your size if needed and click the highlighted button — I'll continue once the cart updates.`,
      buttons: [{ label: 'I added it → checkout', onClick: proceed }, stopBtn]
    }));
    if (!A.cartCount) return;
    const before = (await A.cartCount()) || 0;
    const ok = await DA.waitFor(async () => my !== gen || ((await A.cartCount()) || 0) > before, 20 * 60 * 1000, 400);
    if (ok && my === gen) proceed();
  }

  async function fillNow() {
    const profile = (ctx && ctx.profile) || {};
    if (!profile.email && !profile.firstName && !profile.address1) {
      log('Your checkout profile is empty — fill it in Options', 'warn');
      return { filled: [], missing: [], skipped: Object.keys(profile), empty: true };
    }
    if (A.waitForCheckout) await A.waitForCheckout();
    const fo = { exclude: cfg.checkoutExclude, touched };
    const res = await DA.fill.fillProfile(cfg.checkoutFields, profile, fo);
    if (stopFill) stopFill();
    stopFill = DA.fill.watchAndFill(cfg.checkoutFields, profile, fo, null); // fills fields that appear later (multi-step)
    if (A.focusCard) A.focusCard();
    // Card fields live in the payment provider's iframes; ask the background to fill them from the vault.
    const card = await send({ type: 'requestCardFill' });
    res.card = card && card.ok ? card.card : null;
    if (card && card.ok) {
      log(`Card: filling ${card.card} in the secure payment fields`, 'ok');
      // Multi-step checkouts show the payment step later — ask again when new card frames appear.
      const seen = new WeakSet([...document.querySelectorAll('iframe')]);
      const mo = new MutationObserver(() => {
        const fresh = [...document.querySelectorAll('iframe')].filter((f) => !seen.has(f));
        if (!fresh.length) return;
        fresh.forEach((f) => seen.add(f));
        setTimeout(() => send({ type: 'requestCardFill' }), 800);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 10 * 60 * 1000);
    } else {
      log(`Card not filled: ${(card && card.reason) || 'no answer'}. Pick your card with browser autofill.`, 'warn');
    }
    return res;
  }

  async function checkout(my, page) {
    if (page === 'cart' && A.clickCheckoutOnCart) {
      ui.banner.show('Going to checkout…', opts({ buttons: [stopBtn] }));
      const ok = await A.clickCheckoutOnCart();
      if (!ok && my === gen) {
        await setPhase('checkout', {}, "Couldn't find the Checkout button on the cart page — click it yourself", 'warn');
        ui.banner.show('Click Checkout', opts({ tone: 'warn', sub: "Couldn't find the checkout button. Click it and I'll fill the form.", buttons: [stopBtn] }));
      }
      return;
    }
    if (page !== 'checkout') { A.goToCheckout(); return; }

    ui.banner.show('Filling checkout…', opts({ buttons: [stopBtn] }));
    const res = await fillNow();
    if (my !== gen) return;
    const note = res.empty ? 'Checkout open (profile empty — nothing filled)'
      : `Checkout filled: ${res.filled.join(', ') || 'nothing'}${res.missing.length ? ' · not found: ' + res.missing.join(', ') : ''} · card: ${res.card || 'not filled'}`;
    await send({ type: 'mark', name: 'ready' });
    await setPhase('ready', {}, note, res.missing.length ? 'warn' : 'ok');
    showReady();
  }

  function showReady() {
    const r = run();
    const dry = !!r.dryRun;
    const pay = A.findPayButton ? A.findPayButton() : null;
    if (pay && !dry) ui.highlight(pay);
    const buttons = [];
    if (dry && A.clearCart) {
      buttons.push({ label: 'Clear cart', onClick: async () => { const ok = await A.clearCart(); log(ok ? 'Dry run: cart cleared' : 'Dry run: could not clear cart', ok ? 'ok' : 'warn'); ui.banner.sub(ok ? 'Cart cleared.' : 'Clear failed — remove it from the cart page.'); } });
    }
    buttons.push({ label: 'Done', onClick: () => send({ type: 'stopRun', reason: dry ? 'Dry run finished' : 'Finished' }) });
    ui.banner.show(dry ? 'Dry run complete — nothing submitted' : 'READY — your turn to pay', opts({
      tone: 'ok',
      sub: `${timingText(r)}\n` + (dry
        ? "Don't click pay on a dry run. Clear the cart when you're done."
        : 'Check the card (browser autofill / Shop Pay), solve any CAPTCHA, then click the highlighted button.'),
      buttons
    }));
  }

  async function ready(my, page) {
    if (page === 'checkout') { await fillNow(); if (my === gen) showReady(); return; }
    showReady();
  }

  // Popup → "Fill checkout on this tab" (works with or without a run).
  async function manualFill() {
    const res0 = await send({ type: 'hello', url: location.href });
    if (res0) ctx = Object.assign({}, ctx || {}, { profile: res0.profile, settings: res0.settings, run: (ctx && ctx.run) || res0.run, isRunTab: (ctx && ctx.isRunTab) || false });
    if (A.pageType(location) !== 'checkout') return { error: 'This tab is not on a checkout page yet.' };
    const res = await fillNow();
    const pay = A.findPayButton ? A.findPayButton() : null;
    if (pay) ui.highlight(pay);
    ui.banner.show('Checkout filled', { tone: 'ok', sub: `Filled: ${res.filled.join(', ') || 'nothing'}${res.missing.length ? '\nNot found: ' + res.missing.join(', ') : ''}` });
    log(`Manual fill: ${res.filled.length} field(s) filled${res.missing.length ? ', not found: ' + res.missing.join(', ') : ''}`, res.missing.length ? 'warn' : 'ok');
    return res;
  }

  refresh();
})(typeof self !== 'undefined' ? self : globalThis);
