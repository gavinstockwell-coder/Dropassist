/* global DA */
'use strict';

const $ = (id) => document.getElementById(id);
const SITE_NAMES = { supreme: 'Supreme' };
let state = null;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || {}); }));
}

function flash(text, isErr) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg' + (isErr ? ' err' : '');
  clearTimeout(flash.t);
  flash.t = setTimeout(() => m.classList.add('hidden'), 6000);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function countdownTarget() {
  if (!state) return null;
  const r = state.run;
  const offset = (r && r.active ? r.offsetMs : state.clock && state.clock.offsetMs) || 0;
  if (r && r.active && r.mode === 'scheduled') return { t: r.dropAt, offset, label: `${SITE_NAMES[r.site]} drop — armed` };
  const site = $('site').value;
  const t = state.next[site] || state.weekly;
  return { t, offset, label: 'Next drop' };
}

function tick() {
  const c = countdownTarget();
  if (!c) return;
  $('cdLabel').textContent = c.label;
  $('cd').textContent = DA.time.formatCountdown(c.t - (Date.now() + c.offset));
  $('dropWhen').textContent = new Date(c.t).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function render() {
  const r = state.run || {};
  const phase = r.active ? r.phase : (r.phase === 'stopped' ? 'stopped' : 'idle');
  const badge = $('phase');
  badge.textContent = (r.dryRun && r.active ? 'dry · ' : '') + phase;
  badge.className = 'badge ' + ({ monitoring: 'live', carting: 'live', checkout: 'live', ready: 'ok', manual: 'warn', paused: 'warn', armed: 'live' }[phase] || '');

  $('stop').disabled = !r.active;
  $('arm').disabled = !!r.active;
  $('now').disabled = !!r.active;
  $('dry').disabled = !!r.active;
  $('resume').classList.toggle('hidden', !(r.active && r.phase === 'paused'));

  const c = state.clock;
  $('clock').textContent = c ? `${c.offsetMs >= 0 ? '+' : ''}${c.offsetMs} ms` : 'not synced';

  if (r.id) {
    const items = (r.items || []).map((i) => '• ' + (i.label || [(i.include || []).join(' + '), i.url].filter(Boolean).join(' ') || 'any item') +
      ((i.sizes || []).length ? `  [${i.sizes.join(', ')}]` : '')).join('\n');
    const carted = (r.carted || []).map((x) => `✓ ${x.title}${x.color ? ' – ' + x.color : ''} ${x.size ? '/ ' + x.size : ''}`).join('\n');
    const m = r.marks || {};
    const base = r.mode === 'scheduled' ? r.dropAt - (r.offsetMs || 0) : m.monitor;
    const timing = m.ready && base ? `\nDrop/start → checkout ready: ${DA.fmtMs(m.ready - base)}` : '';
    $('runInfo').textContent = `${SITE_NAMES[r.site] || ''} · ${r.mode === 'scheduled' ? 'armed' : r.mode === 'dry' ? 'dry run' : 'live now'}${r.active ? '' : ' (ended)'}\n${items}${carted ? '\n' + carted : ''}${r.note ? '\n→ ' + r.note : ''}${timing}`;
  } else {
    $('runInfo').textContent = state.enabledCount ? `${state.enabledCount} item(s) on your watchlist` : 'Watchlist is empty — add items in Settings';
  }

  const pre = $('log');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.innerHTML = (state.log || []).map((e) =>
    `<span class="l-${e.lvl}">${DA.fmtClock(e.t)} ${e.site ? '[' + e.site + '] ' : ''}${esc(e.msg)}</span>`).join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;

  const v = state.vault || { profiles: [] };
  const sel = $('profile');
  if (document.activeElement !== sel) {
    sel.innerHTML = v.profiles.map((p) => `<option value="${p.id}">${esc(p.name || 'Profile')}${p.card ? ` · ${p.card.brand} •${p.card.last4}` : ' · no card'}</option>`).join('');
    sel.value = v.activeProfileId;
  }
  const act = v.profiles.find((p) => p.id === v.activeProfileId);
  const needsUnlock = !!(act && act.card && v.exists && !v.unlocked);
  $('vaultState').textContent = !act || !act.card ? 'card: browser autofill' : v.unlocked ? '🔓 card ready' : '🔒 locked';
  $('unlockRow').classList.toggle('hidden', !needsUnlock);

  const warns = [];
  if (needsUnlock) warns.push('card vault locked');
  if (!state.profileSet) warns.push('profile empty');
  if (!state.enabledCount) warns.push('no watchlist items');
  $('warn').textContent = warns.join(' · ');
}

async function refresh() {
  const s = await send({ type: 'getState' });
  if (s && s.run) { state = s; render(); tick(); }
}

async function act(msg, okText) {
  const res = await send(msg);
  if (res.error) flash(res.error, true);
  else if (okText) flash(okText);
  refresh();
  return res;
}

document.addEventListener('DOMContentLoaded', async () => {

  $('arm').addEventListener('click', () => act({ type: 'arm', mode: 'scheduled' }, 'Armed. Leave the browser open — the site tab opens ~1 minute before.'));
  $('now').addEventListener('click', () => act({ type: 'arm', mode: 'now', site: $('site').value }, 'Started.'));
  $('dry').addEventListener('click', () => act({ type: 'arm', mode: 'dry', site: $('site').value, keyword: $('dryKw').value }, 'Dry run started.'));
  $('stop').addEventListener('click', () => act({ type: 'stopRun', reason: 'Stopped from popup' }, 'Stopped.'));
  $('resume').addEventListener('click', () => act({ type: 'resume' }, 'Resumed.'));
  $('fill').addEventListener('click', async () => {
    const res = await send({ type: 'fillActiveTab' });
    if (res.error) flash(res.error, true);
    else flash(`Filled: ${(res.filled || []).join(', ') || 'nothing'}${(res.missing || []).length ? ' · not found: ' + res.missing.join(', ') : ''}`, !!(res.missing || []).length);
  });
  $('sync').addEventListener('click', async () => {
    $('sync').textContent = 'syncing…';
    const res = await send({ type: 'syncClock', site: $('site').value });
    $('sync').textContent = 'sync';
    if (res.error) flash(res.error, true);
    refresh();
  });
  $('copyLog').addEventListener('click', async (e) => {
    e.preventDefault();
    const text = (state.log || []).map((e) => `${DA.fmtClock(e.t)} ${e.lvl.toUpperCase()} ${e.site ? '[' + e.site + '] ' : ''}${e.msg}`).join('\n');
    await navigator.clipboard.writeText(text);
    flash('Log copied.');
  });
  $('clearLog').addEventListener('click', (e) => { e.preventDefault(); act({ type: 'clearLog' }); });
  $('profile').addEventListener('change', () => act({ type: 'setActiveProfile', id: $('profile').value }, 'Active profile changed.'));
  $('unlock').addEventListener('click', async () => {
    const res = await send({ type: 'vaultUnlock', pass: $('vaultPass').value });
    $('vaultPass').value = '';
    if (res.error) flash(res.error, true); else flash('Card vault unlocked until the browser closes.');
    refresh();
  });
  $('vaultPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock').click(); });
  const runResale = async () => {
    const q = $('rq').value.trim();
    if (!q) return;
    $('rout').textContent = 'checking…';
    const r = await send({ type: 'resaleCheck', query: /supreme/i.test(q) ? q : 'Supreme ' + q, size: $('rs').value.trim() });
    if (r.error) { $('rout').textContent = r.error; return; }
    $('rout').textContent = r.text;
    const L = r.links || {};
    $('rlinks').innerHTML = [['StockX', L.stockx], ['GOAT', L.goat], ['Grailed', L.grailed], ['eBay sold', L.ebaySold]]
      .map(([n, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener" style="color:#fff">${n}</a>`).join(' · ');
  };
  $('rgo').addEventListener('click', runResale);
  $('rq').addEventListener('keydown', (e) => { if (e.key === 'Enter') runResale(); });
  $('health').addEventListener('click', async () => {
    const box = $('healthOut');
    box.classList.remove('hidden');
    box.textContent = 'running checks…';
    const r = await send({ type: 'healthCheck' });
    if (r.error) { box.textContent = r.error; return; }
    const icon = { ok: '✓', warn: '!', fail: '✗' };
    const bad = r.checks.filter((c) => c.status === 'fail').length;
    box.innerHTML = `<div class="hsum ${bad ? 'bad' : 'good'}">${bad ? bad + ' problem(s) to fix' : 'ready for the drop'}</div>` +
      r.checks.map((c) => `<div class="h-${c.status}"><b>${icon[c.status]}</b> ${esc(c.name)} — <span>${esc(c.detail)}</span></div>`).join('');
  });
  $('orders').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('orders/orders.html') }); });
  $('opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  await refresh();
  setInterval(tick, 100);
  setInterval(refresh, 1000);
});
