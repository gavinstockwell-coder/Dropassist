/* global DA */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
let items = [];
let profiles = [];
let activeId = null;
let curId = null;
let vault = { exists: false, unlocked: false };
const bg = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (x) => { void chrome.runtime.lastError; r(x || {}); }));

function status(text, isErr) {
  const s = $('#status');
  s.textContent = text;
  s.className = 'status' + (isErr ? ' err' : '');
}

function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderItems() {
  const box = $('#items');
  box.innerHTML = '';
  items.forEach((it, idx) => {
    const node = $('#itemTpl').content.firstElementChild.cloneNode(true);
    node.dataset.idx = idx;
    for (const el of $$('[data-f]', node)) {
      const f = el.dataset.f;
      let v = it[f];
      if (Array.isArray(v)) v = v.join(', ');
      if (f === 'dropAt') v = toLocalInput(it.dropAt);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
    }
    const syncSite = () => {
      node.classList.toggle('off', !$('[data-f="enabled"]', node).checked);
    };
    syncSite();
    node.addEventListener('change', syncSite);
    node.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      collectItems();
      if (act === 'up' && idx > 0) [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
      if (act === 'down' && idx < items.length - 1) [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
      if (act === 'del' && confirm('Delete this watchlist item?')) items.splice(idx, 1);
      renderItems();
      status('Unsaved changes');
    });
    box.appendChild(node);
  });
}

function collectItems() {
  items = $$('#items .item').map((node, i) => {
    const prev = items[Number(node.dataset.idx)] || {};
    const get = (f) => $(`[data-f="${f}"]`, node);
    const dropVal = get('dropAt').value;
    return {
      id: prev.id || DA.uid(),
      enabled: get('enabled').checked,
      site: 'supreme',
      label: get('label').value.trim(),
      include: DA.match.list(get('include').value),
      exclude: DA.match.list(get('exclude').value),
      colors: DA.match.list(get('colors').value),
      sizes: DA.match.list(get('sizes').value),
      url: get('url').value.trim(),
      restock: get('restock').checked,
      category: '',
      dropAt: dropVal ? new Date(dropVal).getTime() : null
    };
  });
  return items;
}

function validate(list) {
  const problems = [];
  list.forEach((it, i) => {
    const n = `Item ${i + 1}${it.label ? ` (${it.label})` : ''}`;
    if (it.enabled && !it.include.length && !it.url) problems.push(`${n}: add keywords or a product URL, or it will buy the first thing it sees.`);
    if (it.url) {
      try {
        const h = new URL(it.url).hostname;
        const want = 'us.supreme.com';
        if (h !== want) problems.push(`${n}: URL is on ${h}, expected ${want}.`);
      } catch (_) { problems.push(`${n}: product URL isn't a full https:// link.`); }
    }
    if (it.dropAt && it.dropAt < Date.now() - 3600e3) problems.push(`${n}: drop time is in the past.`);
  });
  return problems;
}

// ---------- profiles + card vault ----------
const curProfile = () => profiles.find((p) => p.id === curId) || profiles[0];

function collectProfile() {
  const p = curProfile();
  if (!p) return;
  const sh = Object.assign({}, p.shipping);
  for (const el of $$('[data-p]')) {
    if (el.dataset.p === '__name') p.name = el.value.trim() || 'Profile';
    else sh[el.dataset.p] = el.value.trim();
  }
  sh.state = (sh.state || '').toUpperCase();
  sh.country = (sh.country || 'US').toUpperCase();
  p.shipping = sh;
}

// Shipping comes from this page; cards are only ever written by the background (encrypted), so keep stored ones.
async function saveProfiles() {
  const st = await chrome.storage.local.get('profiles');
  const stored = Array.isArray(st.profiles) ? st.profiles : [];
  const merged = profiles.map((p) => Object.assign({}, p, { card: ((stored.find((x) => x.id === p.id) || {}).card) || null }));
  profiles = merged;
  await chrome.storage.local.set({ profiles: merged, activeProfileId: activeId });
}

async function renderProfile() {
  const sel = $('#profileSel');
  sel.innerHTML = profiles.map((p) => `<option value="${p.id}">${(p.name || 'Profile').replace(/</g, '&lt;')}${p.id === activeId ? ' (active)' : ''}${p.card ? ' · ' + p.card.brand + ' •' + p.card.last4 : ''}</option>`).join('');
  sel.value = curId;
  const p = curProfile();
  for (const el of $$('[data-p]')) el.value = el.dataset.p === '__name' ? (p.name || '') : ((p.shipping || {})[el.dataset.p] || '');
  $('#isActive').checked = p.id === activeId;
  $('#delProfile').disabled = profiles.length < 2;
  vault = await bg({ type: 'vaultStatus' });
  renderCard();
}

function renderCard(forceForm) {
  const p = curProfile();
  const line = $('#vaultLine');
  if (!vault.exists) {
    line.innerHTML = 'No card vault yet. Choose a passphrase (you\'ll type it once per browser session): <input id="vPass" type="password" placeholder="passphrase"> <input id="vPass2" type="password" placeholder="repeat">';
  } else if (!vault.unlocked) {
    line.innerHTML = '🔒 Vault locked. <input id="vPass" type="password" placeholder="passphrase"> <button id="vUnlock" class="mini">Unlock</button> <button id="vReset" class="mini del">Forgot passphrase</button>';
    $('#vUnlock').addEventListener('click', async () => { const r = await bg({ type: 'vaultUnlock', pass: $('#vPass').value }); if (r.error) status(r.error, true); else { vault = r; renderCard(); status('Vault unlocked'); } });
    $('#vPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#vUnlock').click(); });
    $('#vReset').addEventListener('click', async () => {
      if (!confirm('Delete ALL saved cards and the passphrase? Shipping info stays.')) return;
      vault = await bg({ type: 'vaultReset' }); await load(); status('Vault reset — add your cards again');
    });
  } else {
    line.innerHTML = '🔓 Vault unlocked for this browser session. <button id="vLock" class="mini">Lock now</button>';
    $('#vLock').addEventListener('click', async () => { vault = await bg({ type: 'vaultLock' }); renderCard(); });
  }
  const has = !!(p && p.card) && !forceForm;
  $('#cardSaved').classList.toggle('hidden', !has);
  $('#cardForm').classList.toggle('hidden', has);
  if (has) $('#cardLabel').textContent = `💳 ${p.card.brand} •••• ${p.card.last4}  exp ${p.card.exp}`;
  $('#saveCard').disabled = vault.exists && !vault.unlocked;
}

async function saveCardClicked() {
  collectProfile();
  await saveProfiles(); // the profile must exist in storage before the card is attached
  if (!vault.exists) {
    const a = ($('#vPass') || {}).value || '', b = ($('#vPass2') || {}).value || '';
    if (a.length < 6) { status('Pick a passphrase of at least 6 characters first', true); return; }
    if (a !== b) { status('Passphrases don\'t match', true); return; }
    const r = await bg({ type: 'vaultCreate', pass: a });
    if (r.error) { status(r.error, true); return; }
    vault = r;
  }
  const res = await bg({ type: 'saveCard', profileId: curId, card: { number: $('#cNumber').value, exp: $('#cExp').value, cvv: $('#cCvv').value, name: $('#cName').value } });
  if (res.error) { status(res.error, true); return; }
  for (const id of ['#cNumber', '#cExp', '#cCvv', '#cName']) $(id).value = '';
  const st = await chrome.storage.local.get('profiles');
  profiles = st.profiles;
  await renderProfile();
  status(`Card saved: ${res.card.brand} •${res.card.last4}`);
}

async function loadKeys() {
  const { resaleKeys = {} } = await chrome.storage.local.get('resaleKeys');
  for (const el of $$('[data-k]')) { const [svc, f] = el.dataset.k.split('.'); el.value = (resaleKeys[svc] || {})[f] || ''; }
}
async function saveKeys() {
  const keys = { stockx: {}, ebay: {} };
  for (const el of $$('[data-k]')) { const [svc, f] = el.dataset.k.split('.'); keys[svc][f] = el.value.trim(); }
  const origins = [];
  if (Object.values(keys.stockx).some(Boolean)) origins.push('https://api.stockx.com/*', 'https://accounts.stockx.com/*');
  if (Object.values(keys.ebay).some(Boolean)) origins.push('https://api.ebay.com/*');
  let granted = true;
  if (origins.length) granted = await chrome.permissions.request({ origins });
  await chrome.storage.local.set({ resaleKeys: keys });
  await chrome.storage.session.remove(['tok_stockx', 'tok_ebay']);
  status(granted ? 'Resale keys saved' : 'Keys saved, but access was not granted — lookups will be skipped', !granted);
}
async function testKeys() {
  const q = $('#testQ').value.trim() || 'Supreme box logo hooded sweatshirt';
  $('#testOut').textContent = 'checking…';
  const r = await bg({ type: 'resaleCheck', query: q });
  $('#testOut').textContent = r.error || r.text;
}

const EV_DEFAULT = { match: true, ready: true, blocked: true, turn: true, resale: true, ended: false };
async function loadPush() {
  const { push = {} } = await chrome.storage.local.get('push');
  $('#pushOn').checked = !!push.enabled;
  $('#pushHook').value = push.webhook || '';
  $('#pushMention').value = push.mention || '';
  const ev = Object.assign({}, EV_DEFAULT, push.events || {});
  for (const el of $$('[data-ev]')) el.checked = ev[el.dataset.ev] !== false;
}
async function savePush() {
  const webhook = $('#pushHook').value.trim();
  if (webhook && !/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook)) { $('#pushOut').textContent = "That doesn't look like a Discord webhook URL."; return false; }
  const events = {};
  for (const el of $$('[data-ev]')) events[el.dataset.ev] = el.checked;
  let granted = true;
  if ($('#pushOn').checked && webhook) granted = await chrome.permissions.request({ origins: ['https://discord.com/*', 'https://discordapp.com/*'] });
  await chrome.storage.local.set({ push: { enabled: $('#pushOn').checked, webhook, mention: $('#pushMention').value.trim(), events } });
  $('#pushOut').textContent = granted ? 'Saved.' : 'Saved, but Discord access was not granted.';
  return granted;
}
async function testPush() {
  if (!(await savePush())) return;
  const r = await bg({ type: 'testPush' });
  $('#pushOut').textContent = r.sent ? 'Sent — check your phone.' : `Not sent: ${r.reason || r.error}`;
}

let pvItems = [];
function renderPreview() {
  const f = DA.match.norm($('#pvFilter').value);
  const box = $('#pvList');
  const shown = pvItems.filter((it) => !f || DA.match.norm(it.title).includes(f));
  box.innerHTML = shown.slice(0, 400).map((it) => `<label class="check pv"><input type="checkbox" data-slug="${it.slug}" ${it.sel ? 'checked' : ''}> <span>${it.title.replace(/</g, '&lt;')}</span> <code>${it.keywords.join(', ')}</code></label>`).join('') || '<p class="note">No items.</p>';
  $$('#pvList input').forEach((el) => el.addEventListener('change', () => { const it = pvItems.find((x) => x.slug === el.dataset.slug); if (it) it.sel = el.checked; }));
}
async function wirePreview() {
  const { seasons = [] } = await bg({ type: 'previewSeasons' });
  $('#pvSeason').innerHTML = seasons.map((s) => `<option value="${s}">${s.replace(/(\d{4})$/, ' $1')}</option>`).join('');
  $('#pvLoad').addEventListener('click', async () => {
    $('#pvOut').textContent = 'loading…';
    const r = await bg({ type: 'fetchPreview', season: $('#pvSeason').value });
    if (r.error) { $('#pvOut').textContent = r.error; return; }
    pvItems = r.items; $('#pvOut').textContent = `${pvItems.length} items`; renderPreview();
  });
  $('#pvFilter').addEventListener('input', renderPreview);
  $('#pvAdd').addEventListener('click', () => {
    const sel = pvItems.filter((x) => x.sel);
    if (!sel.length) { $('#pvOut').textContent = 'Tick some items first.'; return; }
    collectItems();
    const sizes = DA.match.list($('#pvSizes').value);
    for (const it of sel) {
      items.push({ id: DA.uid(), enabled: true, site: 'supreme', label: it.title, include: it.keywords, exclude: [], colors: [], sizes, url: '', category: '', dropAt: null, restock: $('#pvRestock').checked });
      it.sel = false;
    }
    renderItems(); renderPreview();
    status(`Added ${sel.length} item(s) — click Save`);
    $('#pvOut').textContent = `Added ${sel.length}. Click Save.`;
  });
}

async function setLook(patch) {
  const st = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: Object.assign({}, st.settings || {}, patch) });
}
function markLook() {
  const t = $('[data-s="theme"]').value || 'night';
  $$('.look').forEach((b) => b.classList.toggle('on', b.dataset.themePick === t));
}
function wireLook() {
  $$('.look').forEach((b) => b.addEventListener('click', async (e) => {
    e.preventDefault();
    $('[data-s="theme"]').value = b.dataset.themePick; markLook();
    await setLook({ theme: b.dataset.themePick });
  }));
  $('#fontSel').addEventListener('change', () => setLook({ font: $('#fontSel').value }));
  $('#starsChk').addEventListener('change', () => setLook({ stars: $('#starsChk').checked }));
  markLook();
}

function wireProfiles() {
  wireLook();
  wirePreview();
  loadPush();
  $('#savePush').addEventListener('click', savePush);
  $('#testPush').addEventListener('click', testPush);
  loadKeys();
  $('#saveKeys').addEventListener('click', saveKeys);
  $('#testKeys').addEventListener('click', testKeys);
  $('#profileSel').addEventListener('change', async () => { collectProfile(); curId = $('#profileSel').value; await renderProfile(); });
  $('#addProfile').addEventListener('click', async () => {
    collectProfile();
    const p = { id: DA.uid(), name: `Profile ${profiles.length + 1}`, shipping: Object.assign({}, DA.defaults.profile), card: null };
    profiles.push(p); curId = p.id;
    await saveProfiles(); await renderProfile(); status('New profile added');
  });
  $('#delProfile').addEventListener('click', async () => {
    if (profiles.length < 2 || !confirm('Delete this profile and its card?')) return;
    profiles = profiles.filter((p) => p.id !== curId);
    if (activeId === curId) activeId = profiles[0].id;
    curId = activeId;
    await chrome.storage.local.set({ profiles, activeProfileId: activeId });
    await renderProfile(); status('Profile deleted');
  });
  $('#isActive').addEventListener('change', async () => { if ($('#isActive').checked) { activeId = curId; collectProfile(); await saveProfiles(); await renderProfile(); status('Active profile set'); } else $('#isActive').checked = curId === activeId; });
  $('#saveCard').addEventListener('click', saveCardClicked);
  $('#replaceCard').addEventListener('click', () => renderCard(true));
  $('#removeCard').addEventListener('click', async () => {
    if (!confirm('Remove the saved card from this profile?')) return;
    await bg({ type: 'removeCard', profileId: curId });
    const st = await chrome.storage.local.get('profiles'); profiles = st.profiles; await renderProfile(); status('Card removed');
  });
}

async function load() {
  await bg({ type: 'vaultStatus' }); // runs the v1.0 → profiles migration if needed
  const st = await chrome.storage.local.get(['settings', 'profiles', 'activeProfileId', 'watchlist']);
  const settings = DA.clampSettings(st.settings || {});
  profiles = Array.isArray(st.profiles) && st.profiles.length ? st.profiles : [{ id: 'p1', name: 'Main', shipping: Object.assign({}, DA.defaults.profile), card: null }];
  activeId = st.activeProfileId || profiles[0].id;
  if (!profiles.some((p) => p.id === curId)) curId = activeId;
  items = Array.isArray(st.watchlist) ? st.watchlist : DA.defaults.watchlist.slice();
  await renderProfile();
  for (const el of $$('[data-s]')) {
    const v = settings[el.dataset.s];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  $('#dropTime').value = `${String(settings.dropHour).padStart(2, '0')}:${String(settings.dropMinute).padStart(2, '0')}`;
  renderItems();
}

async function save() {
  collectItems();
  const problems = validate(items);
  collectProfile();

  const raw = {};
  for (const el of $$('[data-s]')) raw[el.dataset.s] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
  const [hh, mm] = ($('#dropTime').value || '11:00').split(':').map(Number);
  raw.dropHour = hh; raw.dropMinute = mm;
  raw.dropTz = (raw.dropTz || 'America/New_York').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: raw.dropTz }); } catch (_) { status(`Unknown time zone "${raw.dropTz}"`, true); return; }
  const settings = DA.clampSettings(raw);

  await chrome.storage.local.set({ settings, watchlist: items });
  await saveProfiles();
  for (const el of $$('[data-s]')) { const v = settings[el.dataset.s]; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
  status(problems.length ? `Saved — but: ${problems.join(' ')}` : `Saved ${new Date().toLocaleTimeString()}`, problems.length > 0);
}

document.addEventListener('DOMContentLoaded', async () => {
  await load();
  wireProfiles();
  $('#save').addEventListener('click', save);
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
  document.addEventListener('input', () => status('Unsaved changes'));
  $('#addItem').addEventListener('click', () => {
    collectItems();
    items.push({ id: DA.uid(), enabled: true, site: 'supreme', label: '', include: [], exclude: [], colors: [], sizes: [], url: '', category: '', dropAt: null });
    renderItems();
    status('Unsaved changes');
  });
  $('#testSound').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'testSound', kind: 'ready' }); });
  $('#export').addEventListener('click', async () => {
    collectItems();
    const st = await chrome.storage.local.get(['settings']);
    const blob = new Blob([JSON.stringify({ dropassist: 1, settings: st.settings, watchlist: items }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dropbuddy-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.dropassist !== 1) throw new Error('not a DropBuddy backup');
      const patch = {};
      if (data.settings) patch.settings = DA.clampSettings(data.settings);
      if (Array.isArray(data.watchlist)) patch.watchlist = data.watchlist;
      await chrome.storage.local.set(patch);
      await load();
      status('Imported.');
    } catch (err) { status('Import failed: ' + err.message, true); }
    e.target.value = '';
  });
});
