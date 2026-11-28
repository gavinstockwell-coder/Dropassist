// Service worker: owns the run state, alarms, clock sync, notifications and sound.
// MV3 workers sleep when idle, so everything important lives in chrome.storage.local and chrome.alarms;
// the content script in the run tab does the second-by-second work.
importScripts('lib/ns.js', 'lib/time.js', 'lib/match.js', 'lib/defaults.js', 'lib/vault.js', 'lib/resale.js', 'config/supreme.js');

const DA = self.DA;

const SITES = {
  supreme: { name: 'Supreme', origin: 'https://us.supreme.com', start: '/collections/new', clock: '/cart.js', match: 'https://us.supreme.com/*' }
};
const LIVE_PHASES = ['scheduled', 'armed', 'monitoring', 'carting', 'manual', 'checkout', 'ready', 'paused'];
const MAX_LOG = 500;

async function clearRunAlarms() { await chrome.alarms.clear('da-wake'); await chrome.alarms.clear('da-stop'); }

// ---------------- storage ----------------
async function getSettings() { const { settings } = await chrome.storage.local.get('settings'); return DA.clampSettings(settings || {}); }
// Profiles: [{ id, name, shipping: {...}, card: { enc:{iv,ct}, last4, brand, exp } | null }], one active.
async function getProfiles() {
  const st = await chrome.storage.local.get(['profiles', 'activeProfileId', 'profile']);
  let profiles = Array.isArray(st.profiles) ? st.profiles : null;
  if (!profiles) { // migrate v1.0 single profile
    profiles = [{ id: 'p1', name: 'Main', shipping: Object.assign({}, DA.defaults.profile, st.profile || {}), card: null }];
    await chrome.storage.local.set({ profiles, activeProfileId: 'p1' });
  }
  const active = profiles.find((p) => p.id === st.activeProfileId) || profiles[0];
  return { profiles, active };
}
async function getProfile() { const { active } = await getProfiles(); return Object.assign({}, DA.defaults.profile, (active && active.shipping) || {}); }

// ---------------- card vault ----------------
async function vaultKey() {
  const { vaultKey: raw } = await chrome.storage.session.get('vaultKey');
  return raw ? DA.vault.importKey(raw) : null;
}
async function vaultStatus() {
  const [{ vaultMeta }, { vaultKey: raw }, { profiles, active }] = await Promise.all([chrome.storage.local.get('vaultMeta'), chrome.storage.session.get('vaultKey'), getProfiles()]);
  return {
    exists: !!vaultMeta, unlocked: !!raw, activeProfileId: active && active.id,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, card: p.card ? { brand: p.card.brand, last4: p.card.last4, exp: p.card.exp } : null }))
  };
}
const cardAllow = new Map(); // tabId -> expiry ms: a checkout page in this tab asked for card fill
const isCardFrameUrl = (u) => { try { const h = new URL(u).hostname; return h === 'checkout.pci.shopifyinc.com'; } catch (_) { return false; } };
const isCheckoutUrl = (u) => { try { return !!siteFromUrl(u) && /\/checkout/i.test(new URL(u).pathname); } catch (_) { return false; } };
async function getWatchlist() { const { watchlist } = await chrome.storage.local.get('watchlist'); return Array.isArray(watchlist) ? watchlist : []; }
async function getRun() { const { run } = await chrome.storage.local.get('run'); return run || { active: false, phase: 'idle' }; }

let runChain = Promise.resolve();
function updateRun(mutate) {
  runChain = runChain.catch(() => {}).then(async () => {
    const r = await getRun();
    const next = (await mutate(r)) || r;
    await chrome.storage.local.set({ run: next });
    return next;
  });
  return runChain;
}

let logChain = Promise.resolve();
function L(msg, lvl = 'info', site = '') {
  const entry = { t: Date.now(), lvl, site, msg: String(msg) };
  console[lvl === 'error' ? 'error' : lvl === 'warn' ? 'warn' : 'log'](`[DropBuddy] ${entry.msg}`);
  logChain = logChain.catch(() => {}).then(async () => {
    const { log = [] } = await chrome.storage.local.get('log');
    log.push(entry);
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
    await chrome.storage.local.set({ log });
  });
  return logChain;
}

function siteFromUrl(url) {
  try {
    const h = new URL(url).hostname;
    if (h === 'us.supreme.com') return 'supreme';
  } catch (_) { /* ignore */ }
  return null;
}
function absUrl(site, u) { try { return new URL(u, SITES[site].origin).href; } catch (_) { return SITES[site].origin; } }

// ---------------- clock ----------------
// Server Date headers have 1-second resolution, so we watch for the second to tick over between two
// requests; that pins the server clock to roughly ±(gap/2). Falls back to a single mid-second estimate.
async function syncClock(siteId) {
  const site = SITES[siteId];
  const sample = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const t0 = Date.now();
    let res;
    try { res = await fetch(site.origin + site.clock, { method: 'HEAD', cache: 'no-store', credentials: 'include', signal: ctl.signal }); }
    finally { clearTimeout(timer); }
    const t1 = Date.now();
    const d = Date.parse(res.headers.get('date') || '');
    if (!isFinite(d)) throw new Error('no Date header');
    return { d, mid: (t0 + t1) / 2, rtt: t1 - t0 };
  };
  let prev = null, fallback = null, result = null, failures = 0;
  for (let i = 0; i < 14 && !result && failures < 3; i++) {
    let cur;
    try { cur = await sample(); } catch (e) { failures++; continue; }
    if (!fallback || cur.rtt < fallback.rtt) fallback = cur;
    if (prev && cur.d > prev.d) {
      const boundaryLocal = (prev.mid + cur.mid) / 2;
      result = { offsetMs: Math.round(cur.d - boundaryLocal), accuracyMs: Math.round((cur.mid - prev.mid) / 2 + cur.rtt / 2) };
    }
    prev = cur;
    await DA.sleep(110);
  }
  if (!result && fallback) result = { offsetMs: Math.round(fallback.d + 500 - fallback.mid), accuracyMs: 500 + Math.round(fallback.rtt / 2) };
  if (!result) throw new Error(`Couldn't reach ${site.name} to sync the clock`);
  const clock = Object.assign({ site: siteId, at: Date.now() }, result);
  await chrome.storage.local.set({ clock });
  return clock;
}

// ---------------- alerts ----------------
async function playSound(kind) {
  const s = await getSettings();
  if (!s.sound) return;
  try {
    if (chrome.offscreen && chrome.offscreen.createDocument) {
      let exists = false;
      if (chrome.runtime.getContexts) exists = (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
      if (!exists) {
        await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Alert sound when checkout is ready' })
          .catch((e) => { if (!/single offscreen|already/i.test(String(e))) throw e; });
      }
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'beep', kind });
      return;
    }
  } catch (e) { console.warn('[DropBuddy] offscreen audio unavailable, using page audio', e); }
  const r = await getRun();
  if (r.tabId) chrome.tabs.sendMessage(r.tabId, { type: 'beep', kind }).catch(() => {});
}

async function focusRunTab() {
  const r = await getRun();
  if (!r.tabId) return;
  try {
    const tab = await chrome.tabs.update(r.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
  } catch (_) { /* tab gone */ }
}

// ---------------- phone alerts (Discord webhook) ----------------
// kind → which toggle controls it. Never sends addresses, card info or checkout links.
const PUSH_KIND = { ready: 'ready', manual: 'turn', blocked: 'blocked', match: 'match', resale: 'resale', info: 'ended', restock: 'restock' };
const PUSH_COLOR = { restock: 0x18a957, ready: 0xffffff, manual: 0xf5a623, blocked: 0xf5a623, match: 0x18a957, resale: 0x5865f2, info: 0x777777 };
function validWebhook(u) { return /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(String(u || '').trim()); }
async function pushPhone(title, message, kind, force) {
  try {
    const { push } = await chrome.storage.local.get('push');
    if (!push || !push.enabled || !validWebhook(push.webhook)) return { sent: false, reason: 'phone alerts off or no webhook' };
    const toggle = PUSH_KIND[kind] || 'ended';
    if (!force && push.events && push.events[toggle] === false) return { sent: false, reason: 'event turned off' };
    if (!(await chrome.permissions.contains({ origins: ['https://discord.com/*', 'https://discordapp.com/*'] }))) return { sent: false, reason: 'Discord access not granted' };
    const mention = push.mention && (kind === 'ready' || kind === 'manual' || kind === 'blocked') ? push.mention.trim() + ' ' : '';
    const r = await fetch(push.webhook.trim() + '?wait=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'DropBuddy', content: mention || undefined,
        embeds: [{ title: String(title).slice(0, 250), description: String(message || '').slice(0, 3500), color: PUSH_COLOR[kind] || 0x777777, timestamp: new Date().toISOString() }]
      })
    });
    if (!r.ok) { L(`Discord alert failed: HTTP ${r.status}`, 'warn'); return { sent: false, reason: 'HTTP ' + r.status }; }
    return { sent: true };
  } catch (e) { L(`Discord alert failed: ${e.message}`, 'warn'); return { sent: false, reason: e.message }; }
}

async function alertUser(title, message, kind) {
  pushPhone(title.replace(/^DropBuddy:\s*/, ''), message, kind);
  try {
    await chrome.notifications.create('da-' + Date.now(), {
      type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2,
      requireInteraction: kind === 'ready' || kind === 'manual'
    });
  } catch (e) { console.warn('[DropBuddy] notification failed', e); }
  await playSound(kind === 'ready' ? 'ready' : 'warn');
  if (kind === 'ready' || kind === 'manual' || kind === 'blocked') await focusRunTab();
}

chrome.notifications.onClicked.addListener((id) => { focusRunTab(); chrome.notifications.clear(id); });

// ---------------- run control ----------------
function itemDropAt(item, settings, now) {
  if (item.dropAt) return Number(item.dropAt);
  return DA.time.nextWeeklyDrop(now, {
    weekday: settings.dropWeekday, hour: settings.dropHour, minute: settings.dropMinute,
    timeZone: settings.dropTz, graceMs: settings.runMin * 60000
  });
}

async function arm({ mode, site, keyword }) {
  const [settings, watchlist, profile] = await Promise.all([getSettings(), getWatchlist(), getProfile()]);
  const now = Date.now();
  let items, dropAt, chosen;

  if (mode === 'dry') {
    chosen = site || 'supreme';
    const template = watchlist.find((i) => i.enabled && i.site === chosen) || {};
    const kw = String(keyword || '').trim();
    const isUrl = /^https?:\/\//i.test(kw);
    items = [{
      id: 'dry-' + DA.uid(), enabled: true, site: chosen, label: 'Dry run' + (kw ? `: ${kw}` : ''),
      include: kw && !isUrl ? [kw] : [], exclude: [], colors: [], sizes: template.sizes || [],
      url: isUrl ? kw : '', category: '', dropAt: null
    }];
    dropAt = now;
  } else {
    const enabled = watchlist.filter((i) => i.enabled && SITES[i.site]);
    if (!enabled.length) throw new Error('Your watchlist has no enabled items — add one in Options.');
    if (mode === 'now') {
      chosen = site || enabled[0].site;
      items = enabled.filter((i) => i.site === chosen);
      if (!items.length) throw new Error(`No enabled ${SITES[chosen].name} items in your watchlist.`);
      dropAt = now;
    } else {
      const grace = settings.runMin * 60000;
      const timed = enabled.map((i) => ({ i, t: itemDropAt(i, settings, now) }))
        .filter((x) => x.t > now - grace).sort((a, b) => a.t - b.t);
      if (!timed.length) throw new Error('No upcoming drop: every custom drop time is in the past.');
      dropAt = timed[0].t;
      chosen = timed[0].i.site;
      items = timed.filter((x) => x.i.site === chosen && Math.abs(x.t - dropAt) <= 5 * 60000).map((x) => x.i);
      const other = enabled.length - items.length;
      if (other) L(`${other} watchlist item(s) are for a different site or drop time and aren't in this run`);
    }
  }

  let clock = null;
  try { clock = await syncClock(chosen); } catch (e) { L(`Clock sync failed (${e.message}); using your computer's clock`, 'warn', chosen); }
  const offsetMs = clock ? clock.offsetMs : 0;
  const leadMs = mode === 'scheduled' ? settings.leadSec * 1000 : 0;
  const startAt = mode === 'scheduled' ? dropAt - leadMs : now + offsetMs;

  const run = {
    active: true, id: DA.uid(), mode, dryRun: mode === 'dry', site: chosen, items,
    dropAt: mode === 'scheduled' ? dropAt : now + offsetMs,
    startAt, stopAt: (mode === 'scheduled' ? dropAt : now + offsetMs) + settings.runMin * 60000,
    onlyNew: mode === 'scheduled' && settings.onlyNew,
    phase: 'scheduled', tabId: null, offsetMs, baseline: null,
    picks: [], carted: [], doneItemIds: [], marks: {}, blocked: null, note: '', resumePhase: null
  };
  await chrome.storage.local.set({ run });
  await clearRunAlarms();

  const names = items.map((i) => i.label || [DA.match.list(i.include).join(' + '), i.url].filter(Boolean).join(' ') || 'any item').join('; ');
  if (mode === 'scheduled') {
    L(`Armed for ${SITES[chosen].name} drop at ${DA.time.formatInZone(dropAt, settings.dropTz)} (${new Date(dropAt).toLocaleString()} your time). Items: ${names}`, 'ok', chosen);
  } else {
    L(`${mode === 'dry' ? 'Dry run' : 'Live run'} started on ${SITES[chosen].name}. Items: ${names}`, 'ok', chosen);
  }
  if (!profile.email && !profile.address1) L('Checkout profile is empty — fill it in Options or checkout won\'t be autofilled', 'warn');
  const vs = await vaultStatus();
  const ap = vs.profiles.find((p) => p.id === vs.activeProfileId);
  if (ap && ap.card && !vs.unlocked) L(`Card vault is locked — ${ap.card.brand} •${ap.card.last4} won't be filled. Unlock it in the popup.`, 'warn');

  const wakeLocal = startAt - offsetMs - 60000;
  if (Date.now() >= wakeLocal) await wake();
  else chrome.alarms.create('da-wake', { when: wakeLocal });
  chrome.alarms.create('da-stop', { when: run.stopAt - offsetMs + 2000 });
  return getRun();
}

// ~60 s before monitoring: re-sync the clock, open/focus the site tab, hand control to the content script.
async function wake() {
  const r0 = await getRun();
  if (!r0.active) return;
  try {
    const clock = await syncClock(r0.site);
    await updateRun((r) => { r.offsetMs = clock.offsetMs; return r; });
    L(`Clock synced with ${SITES[r0.site].name}: offset ${clock.offsetMs >= 0 ? '+' : ''}${clock.offsetMs} ms (±${clock.accuracyMs} ms)`, 'info', r0.site);
  } catch (e) { L(`Clock re-sync failed: ${e.message}`, 'warn', r0.site); }
  await updateRun((r) => { if (r.phase === 'scheduled') r.phase = 'armed'; return r; });
  await openRunTab();
}

async function openRunTab() {
  const r = await getRun();
  const site = SITES[r.site];
  let url = site.origin + site.start;
  const urlItem = (r.items || []).find((i) => i.url);
  if (urlItem && (r.items || []).length === 1) url = absUrl(r.site, urlItem.url);

  let tab = null;
  if (r.tabId) tab = await chrome.tabs.get(r.tabId).catch(() => null);
  if (!tab) {
    const tabs = await chrome.tabs.query({ url: site.match });
    tab = tabs.find((t) => t.active) || tabs[0] || null;
  }
  if (tab) tab = await chrome.tabs.update(tab.id, { active: true, url });
  else {
    try { tab = await chrome.tabs.create({ url, active: true }); }
    catch (_) { // no browser window open (e.g. browser running in the background)
      const win = await chrome.windows.create({ url, focused: true });
      tab = win.tabs[0];
    }
  }
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await updateRun((x) => { x.tabId = tab.id; return x; });
}

async function stopRun(reason, lvl = 'info') {
  const r = await updateRun((x) => { x.active = false; x.phase = 'stopped'; x.note = reason; return x; });
  await clearRunAlarms();
  L(reason, lvl, r.site || '');
  if (r.tabId) chrome.tabs.sendMessage(r.tabId, { type: 'runChanged' }).catch(() => {});
  return r;
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'da-restock') await restockTick();
  if (a.name === 'da-wake') await wake();
  if (a.name === 'da-stop') {
    const r = await getRun();
    if (r.active && ['scheduled', 'armed', 'monitoring', 'paused'].includes(r.phase)) {
      await stopRun('Monitoring window ended with no match', 'warn');
      await alertUser('DropBuddy: window closed', 'Nothing on your watchlist matched during the drop window.', 'info');
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const r = await getRun();
  if (r.active && r.tabId === tabId) {
    await updateRun((x) => { x.tabId = null; return x; });
    L('The run tab was closed. Open the site again and the run continues in that tab.', 'warn', r.site);
  }
});


// ======================================================================
// Pre-drop check · Supreme preview import · restock watcher · purchase log
// ======================================================================
const SUP = DA.config.supreme;

async function fetchSupremeProducts(path) {
  const r = await fetch(SITES.supreme.origin + path, { cache: 'no-store', credentials: 'include', headers: { Accept: 'text/html' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}`);
  const m = (await r.text()).match(SUP.productsJsonRe);
  if (!m) throw new Error(`product data not found on ${path} (site changed?)`);
  return (JSON.parse(m[1]).products || []).map((p) => ({
    id: String(p.id), title: p.title || '', color: p.color || '', style: p.style || '', handle: p.handle,
    url: (p.url || '/products/' + p.handle).split('?')[0], price: typeof p.price === 'number' ? p.price : null,
    variants: (p.variants || []).map((v) => ({ id: v.id, title: v.title || v.public_title || 'One size', available: !!v.available }))
  }));
}

// ---------- 1. pre-drop check ----------
async function healthCheck() {
  const out = [];
  const add = (name, status, detail) => out.push({ name, status, detail });
  const [settings, watchlist, { active }, vs, push] = await Promise.all([getSettings(), getWatchlist(), getProfiles(), vaultStatus(), chrome.storage.local.get('push').then((x) => x.push)]);
  const enabled = watchlist.filter((i) => i.enabled && SITES[i.site]);
  add('Watchlist', enabled.length ? 'ok' : 'fail', enabled.length ? `${enabled.length} item(s) enabled` : 'no enabled items');
  const sh = (active && active.shipping) || {};
  const miss = ['email', 'firstName', 'lastName', 'address1', 'city', 'state', 'zip', 'phone'].filter((k) => !sh[k]);
  add('Shipping profile', miss.length ? 'fail' : 'ok', miss.length ? `missing: ${miss.join(', ')}` : `${active.name}: ${sh.city}, ${sh.state}`);
  const ap = vs.profiles.find((p) => p.id === vs.activeProfileId);
  if (!ap || !ap.card) add('Card', 'warn', 'no saved card — you will pick one with browser autofill');
  else if (/^\d\d\/\d\d$/.test(ap.card.exp) && (() => { const [mm, yy] = ap.card.exp.split('/').map(Number); return new Date(2000 + yy, mm, 1) <= new Date(); })()) add('Card', 'fail', `${ap.card.brand} •${ap.card.last4} expired (${ap.card.exp})`);
  else add('Card', vs.unlocked ? 'ok' : 'fail', `${ap.card.brand} •${ap.card.last4} — ${vs.unlocked ? 'vault unlocked' : 'vault LOCKED: unlock in the popup'}`);
  try { const c = await syncClock('supreme'); add('Server clock', Math.abs(c.offsetMs) > 3000 ? 'warn' : 'ok', `offset ${c.offsetMs >= 0 ? '+' : ''}${c.offsetMs} ms (±${c.accuracyMs})`); }
  catch (e) { add('Server clock', 'warn', e.message); }
  try {
    const products = await fetchSupremeProducts(SUP.listingPath);
    add('Supreme product feed', products.length ? 'ok' : 'warn', `${products.length} products readable on ${SUP.listingPath}`);
    for (const it of enabled) {
      const hits = products.filter((p) => DA.match.evaluate(p, Object.assign({}, it, { sizes: [], colors: [] }), {}).candidate &&
        DA.match.list(it.include).every((t) => DA.match.hasTerm(DA.match.norm([p.title, p.color, p.style].join(' ')), t))).length;
      add(`Keywords · ${it.label || DA.match.list(it.include).join(' + ') || it.url}`, 'ok', hits ? `${hits} product(s) on the site match right now (old stock or already live)` : 'nothing matches right now (normal before a drop)');
    }
  } catch (e) { add('Supreme product feed', 'fail', e.message); }
  let lvl = 'granted';
  try { lvl = await new Promise((r) => chrome.notifications.getPermissionLevel(r)); } catch (_) { /* ignore */ }
  add('Desktop notifications', lvl === 'granted' ? 'ok' : 'fail', lvl === 'granted' ? 'allowed (also check Windows Focus Assist / Do Not Disturb)' : 'blocked for this extension');
  add('Sound', settings.sound ? 'ok' : 'warn', settings.sound ? 'on — use "test sound" to hear it' : 'off');
  if (push && push.enabled) {
    const okPerm = await chrome.permissions.contains({ origins: ['https://discord.com/*', 'https://discordapp.com/*'] }).catch(() => false);
    add('Phone alerts', validWebhook(push.webhook) && okPerm ? 'ok' : 'fail', validWebhook(push.webhook) ? (okPerm ? 'Discord webhook set' : 'Discord access not granted') : 'webhook URL invalid');
  } else add('Phone alerts', 'warn', 'off (Options → Phone alerts)');
  const now = Date.now();
  const next = DA.time.nextWeeklyDrop(now, { weekday: settings.dropWeekday, hour: settings.dropHour, minute: settings.dropMinute, timeZone: settings.dropTz });
  const run = await getRun();
  add('Armed', run.active ? 'ok' : 'warn', run.active ? `${run.mode} run in progress (${run.phase})` : `not armed — next drop ${DA.time.formatInZone(next, settings.dropTz)}`);
  return out;
}

// ---------- 3. Supreme preview import ----------
function previewSeasons(now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const cur = m >= 8 ? `fallwinter${y}` : m === 1 ? `fallwinter${y - 1}` : `springsummer${y}`;
  const prev = cur.startsWith('fall') ? `springsummer${cur.slice(-4)}` : `fallwinter${y - 1}`;
  return [cur, prev];
}
async function fetchPreview(season) {
  if (!/^(fallwinter|springsummer)\d{4}$/.test(season)) throw new Error('Season should look like fallwinter2026');
  const r = await fetch(`https://supreme.com/previews/${season}/all`, { cache: 'no-store', credentials: 'omit' });
  if (!r.ok) throw new Error(`Preview page: HTTP ${r.status}`);
  const html = await r.text();
  let raw = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html))) { try { raw += JSON.parse(m[1]); } catch (_) { /* skip chunk */ } }
  const items = [], seen = new Set();
  const r2 = /"slug":"([a-z0-9-]+)","title":"([^"]+)","variants"/g;
  while ((m = r2.exec(raw))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const title = m[2].replace(/\s+/g, ' ').trim();
    items.push({ slug: m[1], title, keywords: DA.match.keywordsFromTitle(title) });
  }
  if (!items.length) throw new Error('No items found on the preview page (site changed, or this season has no preview yet)');
  return items;
}

// ---------- 4. restock watcher (alerts only; never buys) ----------
async function setupRestockAlarm() {
  const s = await getSettings();
  const wl = await getWatchlist();
  const any = wl.some((i) => i.enabled && i.restock);
  await chrome.alarms.clear('da-restock');
  if (s.restockOn && any) chrome.alarms.create('da-restock', { periodInMinutes: Math.max(1, Number(s.restockMin) || 2), delayInMinutes: 0.1 });
}
async function restockTick() {
  const r = await getRun();
  if (r.active && ['armed', 'monitoring', 'carting', 'checkout', 'manual'].includes(r.phase)) return; // a drop run is busy
  const items = (await getWatchlist()).filter((i) => i.enabled && i.restock && SITES[i.site]);
  if (!items.length) return;
  let products = null;
  for (const path of ['/collections/all', SUP.listingPath]) {
    try { products = await fetchSupremeProducts(path); break; } catch (_) { /* try next */ }
  }
  if (!products) { L('Restock watch: could not read Supreme product data', 'warn', 'supreme'); return; }
  const { restockSeen = {} } = await chrome.storage.local.get('restockSeen');
  const live = {};
  for (const it of items) {
    const { picks } = DA.match.planPicks(products, [it], {});
    for (const p of picks) {
      const key = `${it.id}|${p.productId}|${p.variantId}`;
      live[key] = 1;
      if (restockSeen[key]) continue;
      const line = `${p.title}${p.color ? ' – ' + p.color : ''}${p.sizeLabel ? ' / ' + p.sizeLabel : ''} is in stock`;
      await L(`Restock · ${line}`, 'ok', 'supreme');
      chrome.notifications.create('da-rs-' + Date.now(), { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Restock', message: line, priority: 2 });
      pushPhone('Restock', `${line}\n${SITES.supreme.origin}${p.url}`, 'restock');
      playSound('warn');
    }
  }
  await chrome.storage.local.set({ restockSeen: live }); // sizes that sell out again will alert on their next restock
}

// ---------- 5. purchase & profit log ----------
const resaleCache = {};
async function logOrders(r) {
  if (r.dryRun || !(r.carted || []).length) return;
  const { orders = [] } = await chrome.storage.local.get('orders');
  for (const c of r.carted) {
    const est = resaleCache[c.productId] || null;
    orders.push({
      id: DA.uid(), at: Date.now(), runId: r.id, title: c.title, color: c.color || '', size: c.size || '',
      retail: c.price != null ? c.price / 100 : null, resaleEst: est, status: 'pending', sold: null, feePct: 12, note: ''
    });
  }
  await chrome.storage.local.set({ orders });
  L(`Added ${r.carted.length} item(s) to the purchase log — mark them Bought / Missed there`, 'info', r.site);
}

// ---------------- messages ----------------
async function handle(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case 'hello': {
      const [settings, profile] = await Promise.all([getSettings(), getProfile()]);
      let r = await getRun();
      const site = siteFromUrl(msg.url || (sender.tab && sender.tab.url) || '');
      if (tabId && r.active && !r.tabId && site === r.site && r.phase !== 'scheduled') {
        r = await updateRun((x) => { x.tabId = tabId; return x; });
        L('Run continues in this tab', 'info', site);
      }
      return { isRunTab: !!(tabId && r.active && r.tabId === tabId), run: r, settings, profile, items: r.items || [] };
    }
    case 'log':
      await L(msg.msg, msg.lvl, msg.site || siteFromUrl(sender.url || '') || '');
      return { ok: true };
    case 'mark': {
      const r = await updateRun((x) => { x.marks = x.marks || {}; if (!x.marks[msg.name]) x.marks[msg.name] = Date.now(); return x; });
      return { run: r };
    }
    case 'phase': {
      const prev = await getRun();
      if (!prev.active) return { run: prev };
      const r = await updateRun((x) => {
        Object.assign(x, msg.patch || {});
        x.phase = msg.phase;
        if (msg.note) x.note = msg.note;
        x.marks = x.marks || {};
        if (msg.phase === 'monitoring' && !x.marks.monitor) x.marks.monitor = Date.now();
        if (msg.phase === 'stopped') x.active = false;
        return x;
      });
      if (msg.note) await L(msg.note, msg.lvl || 'info', r.site);
      if (msg.phase === 'carting' && prev.phase === 'monitoring') {
        resaleForPicks(r.picks || [], r.site);
        pushPhone(r.dryRun ? 'Match (dry run)' : 'Match — adding to cart', (r.picks || []).map((p) => `• ${p.title}${p.color ? ' – ' + p.color : ''}${p.sizeLabel ? ' / ' + p.sizeLabel : ''}`).join('\n'), 'match');
      }
      if (msg.phase !== prev.phase) await onPhaseChange(prev, r);
      return { run: r };
    }
    case 'blocked': {
      const prev = await getRun();
      if (!prev.active || prev.blocked === msg.kind) return { ok: true };
      await updateRun((x) => { x.blocked = msg.kind; return x; });
      L(`${msg.kind === 'captcha' ? 'CAPTCHA' : 'Queue / waiting room'} on ${msg.url || 'page'} — paused until it clears`, 'warn', prev.site);
      await alertUser(msg.kind === 'captcha' ? 'DropBuddy: CAPTCHA' : 'DropBuddy: in the queue',
        msg.kind === 'captcha' ? 'Solve the CAPTCHA — automation resumes after.' : 'Waiting room — automation resumes when you get through.', 'blocked');
      return { ok: true };
    }
    case 'unblocked': {
      const r = await updateRun((x) => { x.blocked = null; return x; });
      L('Cleared — resuming', 'ok', r.site);
      return { ok: true };
    }
    case 'stopRun':
      return { run: await stopRun(msg.reason || 'Stopped') };
    case 'resume': {
      const r = await updateRun((x) => { if (x.phase === 'paused') { x.phase = x.resumePhase || 'monitoring'; x.resumePhase = null; x.active = true; } return x; });
      L('Resumed', 'info', r.site);
      if (r.tabId) chrome.tabs.sendMessage(r.tabId, { type: 'runChanged' }).catch(() => {});
      else if (r.active) await openRunTab();
      return { run: r };
    }

    case 'healthCheck':
      return { checks: await healthCheck() };
    case 'previewSeasons':
      return { seasons: previewSeasons() };
    case 'fetchPreview':
      return { items: await fetchPreview(msg.season) };
    case 'restockSetup':
      await setupRestockAlarm();
      return { ok: true };
    case 'restockNow':
      await restockTick();
      return { ok: true };
    case 'testPush':
      return pushPhone('Test alert', 'If you can read this on your phone, DropBuddy alerts are working.', 'ready', true);
    case 'resaleCheck': {
      const r = await DA.resale.lookup(String(msg.query || '').trim(), msg.size || null, msg.retail || null);
      return Object.assign(r, { text: DA.resale.summary(r) });
    }
    // ---- card fill ----
    case 'requestCardFill': { // from the checkout page (top frame) right after it fills shipping
      if (!tabId || sender.frameId !== 0 || !isCheckoutUrl(sender.url || '')) return { ok: false, reason: 'not a checkout page' };
      const { active } = await getProfiles();
      if (!active || !active.card) return { ok: false, reason: 'no card saved on the active profile' };
      if (!(await vaultKey())) return { ok: false, reason: 'card vault is locked — unlock it in the popup' };
      cardAllow.set(tabId, Date.now() + 120000);
      chrome.tabs.sendMessage(tabId, { type: 'cardFillNow' }).catch(() => {}); // reaches every frame in the tab
      return { ok: true, card: `${active.card.brand} •${active.card.last4}` };
    }
    case 'cardField': { // from a payment iframe inside that checkout tab
      if (!tabId || sender.frameId === 0 || !isCardFrameUrl(sender.url || '')) return { value: null };
      if (!isCheckoutUrl((sender.tab && sender.tab.url) || '') || !((cardAllow.get(tabId) || 0) > Date.now())) return { value: null };
      const key = await vaultKey();
      const { active } = await getProfiles();
      if (!key || !active || !active.card) return { value: null };
      const c = await DA.vault.decryptJSON(key, active.card.enc);
      const fullName = [active.shipping.firstName, active.shipping.lastName].filter(Boolean).join(' ');
      const value = { number: c.number, exp: `${c.mm} / ${c.yy}`, cvv: c.cvv, name: c.name || fullName }[msg.field];
      return { value: value == null ? null : value };
    }
    case 'vaultStatus':
      return vaultStatus();
    case 'vaultCreate': {
      const { vaultMeta } = await chrome.storage.local.get('vaultMeta');
      if (vaultMeta) throw new Error('A vault already exists — unlock it instead');
      const { meta, key } = await DA.vault.create(msg.pass);
      await chrome.storage.local.set({ vaultMeta: meta });
      await chrome.storage.session.set({ vaultKey: await DA.vault.exportKey(key) });
      L('Card vault created and unlocked', 'ok');
      return vaultStatus();
    }
    case 'vaultUnlock': {
      const { vaultMeta } = await chrome.storage.local.get('vaultMeta');
      if (!vaultMeta) throw new Error('No vault yet — add a card in Options first');
      const key = await DA.vault.unlock(vaultMeta, msg.pass);
      await chrome.storage.session.set({ vaultKey: await DA.vault.exportKey(key) });
      L('Card vault unlocked until the browser closes', 'ok');
      return vaultStatus();
    }
    case 'vaultLock':
      await chrome.storage.session.remove('vaultKey');
      return vaultStatus();
    case 'vaultReset': { // forgot passphrase: wipes every saved card, keeps shipping
      const { profiles } = await getProfiles();
      for (const p of profiles) p.card = null;
      await chrome.storage.local.set({ profiles });
      await chrome.storage.local.remove('vaultMeta');
      await chrome.storage.session.remove('vaultKey');
      L('Card vault reset — all saved cards deleted', 'warn');
      return vaultStatus();
    }
    case 'saveCard': {
      const key = await vaultKey();
      if (!key) throw new Error('Unlock the card vault first');
      const card = DA.vault.normalizeCard(msg.card);
      const { profiles } = await getProfiles();
      const p = profiles.find((x) => x.id === msg.profileId);
      if (!p) throw new Error('Profile not found — save the profile first');
      p.card = { enc: await DA.vault.encryptJSON(key, card), last4: card.number.slice(-4), brand: DA.vault.cardBrand(card.number), exp: `${card.mm}/${card.yy}` };
      await chrome.storage.local.set({ profiles });
      return { card: { brand: p.card.brand, last4: p.card.last4, exp: p.card.exp } };
    }
    case 'removeCard': {
      const { profiles } = await getProfiles();
      const p = profiles.find((x) => x.id === msg.profileId);
      if (p) p.card = null;
      await chrome.storage.local.set({ profiles });
      return { ok: true };
    }
    case 'setActiveProfile':
      await chrome.storage.local.set({ activeProfileId: msg.id });
      return vaultStatus();

    // ---- popup / options ----
    case 'getState': {
      const [run, settings, watchlist, profile, store] = await Promise.all([getRun(), getSettings(), getWatchlist(), getProfile(), chrome.storage.local.get(['log', 'clock'])]);
      const now = Date.now();
      const enabled = watchlist.filter((i) => i.enabled && SITES[i.site]);
      const next = { supreme: null };
      for (const i of enabled) {
        const t = itemDropAt(i, settings, now);
        if (t > now - settings.runMin * 60000 && (!next[i.site] || t < next[i.site])) next[i.site] = t;
      }
      const weekly = DA.time.nextWeeklyDrop(now, { weekday: settings.dropWeekday, hour: settings.dropHour, minute: settings.dropMinute, timeZone: settings.dropTz });
      return {
        run, settings, enabledCount: enabled.length, sitesEnabled: [...new Set(enabled.map((i) => i.site))],
        profileSet: !!(profile.email && profile.address1), next, weekly,
        clock: store.clock || null, log: (store.log || []).slice(-200), vault: await vaultStatus()
      };
    }
    case 'arm':
      return { run: await arm(msg) };
    case 'syncClock':
      return { clock: await syncClock(msg.site || 'supreme') };
    case 'clearLog':
      await chrome.storage.local.set({ log: [] });
      return { ok: true };
    case 'testSound':
      await playSound(msg.kind || 'ready');
      return { ok: true };
    case 'fillActiveTab': {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || !siteFromUrl(tab.url || '')) return { error: 'Open the Supreme checkout page in the current tab first.' };
      try { return await chrome.tabs.sendMessage(tab.id, { type: 'fillNow' }); }
      catch (_) { return { error: 'The page isn\'t ready (or was open before the extension loaded) — reload it and try again.' }; }
    }
    default:
      return { error: 'unknown message ' + msg.type };
  }
}

// On a match, look up resale value for what's about to be bought (never blocks checkout).
function resaleForPicks(picks, site) {
  for (const p of picks) {
    const q = ['Supreme', p.title.replace(/^Supreme®?\s*/i, ''), p.color].filter(Boolean).join(' ');
    DA.resale.lookup(q, p.sizeLabel, p.price ? p.price / 100 : null)
      .then((r) => {
        if (r.estimate) resaleCache[p.productId] = r.estimate;
        const line = `${p.title}${p.color ? ' – ' + p.color : ''}${p.sizeLabel ? ' / ' + p.sizeLabel : ''}: ${DA.resale.summary(r)}`;
        L(`Resale · ${line}`, 'info', site);
        pushPhone('Resale check', line, 'resale');
      })
      .catch(() => {});
  }
}

async function onPhaseChange(prev, r) {
  if (r.phase === 'ready') {
    logOrders(r);
    await alertUser(r.dryRun ? 'DropBuddy: dry run reached checkout' : 'DropBuddy: READY — click pay',
      (r.dryRun ? 'Nothing was submitted. Clear the cart when done.' : (r.carted || []).map((c) => `• ${c.title}${c.color ? ' – ' + c.color : ''} ${c.size}`).join('\n') || 'Checkout is filled.') +
      (r.marks && r.marks.ready ? `\nDrop/start → checkout ready: ${DA.fmtMs(r.marks.ready - (r.mode === 'scheduled' ? r.dropAt - (r.offsetMs || 0) : r.marks.monitor))}` : '') +
      (r.dryRun ? '' : '\nGo to your computer — confirm card / CAPTCHA and click pay.'), 'ready');
  } else if (r.phase === 'manual') {
    await alertUser('DropBuddy: your turn', 'Click Add to Cart on the highlighted button — the site rejected the automated click.', 'manual');
  } else if (r.phase === 'paused') {
    await alertUser('DropBuddy: paused', r.note || 'Paused.', 'blocked');
  } else if (r.phase === 'stopped' && prev.phase !== 'stopped') {
    await clearRunAlarms();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  handle(msg, sender).then(
    (res) => sendResponse(res),
    (e) => { L(`Error: ${e && e.message || e}`, 'error'); sendResponse({ error: String((e && e.message) || e) }); }
  );
  return true;
});

// ---------------- lifecycle ----------------
chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.local.get(['settings', 'profile', 'watchlist']);
  const patch = {};
  if (!cur.settings) patch.settings = DA.defaults.settings;
  if (!cur.watchlist) patch.watchlist = DA.defaults.watchlist;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  setupRestockAlarm();
});

// After a browser restart: drop stale runs, re-create alarms for live ones.
async function restore() {
  const r = await getRun();
  if (!r.active) return;
  const now = Date.now() + (r.offsetMs || 0);
  if (now > r.stopAt && LIVE_PHASES.slice(0, 4).includes(r.phase)) { await stopRun('Run expired while the browser was closed', 'warn'); return; }
  const alarms = await chrome.alarms.getAll();
  if (!alarms.some((a) => a.name === 'da-stop')) chrome.alarms.create('da-stop', { when: r.stopAt - (r.offsetMs || 0) + 2000 });
  if (r.phase === 'scheduled' && !alarms.some((a) => a.name === 'da-wake')) {
    const wakeLocal = r.startAt - (r.offsetMs || 0) - 60000;
    if (Date.now() >= wakeLocal) await wake(); else chrome.alarms.create('da-wake', { when: wakeLocal });
  }
}
chrome.runtime.onStartup.addListener(() => { restore(); setupRestockAlarm(); });
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.settings || ch.watchlist)) setupRestockAlarm(); });
