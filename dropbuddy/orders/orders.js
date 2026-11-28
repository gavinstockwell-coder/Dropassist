/* global DA */
'use strict';
const $ = (s) => document.querySelector(s);
let orders = [];
const money = (n) => (n == null || !isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function profit(o) {
  if (o.status !== 'sold' || o.sold == null || o.retail == null) return null;
  return o.sold * (1 - (Number(o.feePct) || 0) / 100) - o.retail;
}
async function save(msg) { await chrome.storage.local.set({ orders }); if (msg) { $('#status').textContent = msg; setTimeout(() => ($('#status').textContent = ''), 2000); } }
function render() {
  const tb = $('#tbl tbody');
  tb.innerHTML = orders.slice().reverse().map((o) => {
    const p = profit(o);
    return `<tr data-id="${o.id}">
      <td>${new Date(o.at).toLocaleDateString()}</td>
      <td><input data-f="title" value="${esc(o.title)}"><small class="note">${esc(o.color)}</small></td>
      <td><input data-f="size" value="${esc(o.size)}" style="width:70px"></td>
      <td><input data-f="retail" type="number" step="0.01" value="${o.retail ?? ''}" style="width:80px"></td>
      <td class="num">${money(o.resaleEst)}</td>
      <td><select data-f="status">${['pending', 'bought', 'missed', 'sold', 'kept'].map((s) => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      <td><input data-f="sold" type="number" step="0.01" value="${o.sold ?? ''}" style="width:80px"></td>
      <td><input data-f="feePct" type="number" step="0.5" value="${o.feePct ?? 12}" style="width:60px"></td>
      <td class="num ${p == null ? '' : p >= 0 ? 'pos' : 'neg'}">${money(p)}</td>
      <td><button data-del class="mini del">✕</button></td></tr>`;
  }).join('') || '<tr><td colspan="10" class="note">Nothing logged yet. Checkouts DropBuddy reaches (not dry runs) appear here.</td></tr>';
  const got = orders.filter((o) => ['bought', 'sold', 'kept'].includes(o.status));
  const sold = orders.filter((o) => o.status === 'sold');
  const spent = got.reduce((a, o) => a + (o.retail || 0), 0);
  const prof = sold.reduce((a, o) => a + (profit(o) || 0), 0);
  const tries = orders.filter((o) => o.status !== 'pending').length;
  $('#totals').innerHTML = [
    ['Secured', `${got.length}`], ['Hit rate', tries ? Math.round((got.length / tries) * 100) + '%' : '—'],
    ['Spent (retail)', money(spent)], ['Sold', `${sold.length}`], ['Realized profit', money(prof)],
    ['Pending', `${orders.filter((o) => o.status === 'pending').length}`]
  ].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
}
document.addEventListener('DOMContentLoaded', async () => {
  orders = (await chrome.storage.local.get('orders')).orders || [];
  render();
  $('#tbl').addEventListener('change', async (e) => {
    const tr = e.target.closest('tr'); const f = e.target.dataset.f;
    const o = orders.find((x) => x.id === tr.dataset.id); if (!o || !f) return;
    let v = e.target.value;
    if (['retail', 'sold', 'feePct'].includes(f)) v = v === '' ? null : Number(v);
    o[f] = v; await save('Saved'); render();
  });
  $('#tbl').addEventListener('click', async (e) => {
    if (!e.target.hasAttribute('data-del')) return;
    const id = e.target.closest('tr').dataset.id;
    if (!confirm('Delete this entry?')) return;
    orders = orders.filter((o) => o.id !== id); await save('Deleted'); render();
  });
  $('#add').addEventListener('click', async () => {
    orders.push({ id: DA.uid(), at: Date.now(), title: 'New item', color: '', size: '', retail: null, resaleEst: null, status: 'bought', sold: null, feePct: 12, note: '' });
    await save('Added'); render();
  });
  $('#csv').addEventListener('click', () => {
    const head = ['date', 'title', 'color', 'size', 'retail', 'resale_est', 'status', 'sold', 'fee_pct', 'profit'];
    const rows = orders.map((o) => [new Date(o.at).toISOString().slice(0, 10), o.title, o.color, o.size, o.retail, o.resaleEst, o.status, o.sold, o.feePct, profit(o) == null ? '' : profit(o).toFixed(2)]);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'dropbuddy-purchases.csv'; a.click();
  });
});
