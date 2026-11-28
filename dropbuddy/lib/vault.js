// Encrypted card storage. AES-256-GCM with a key derived from your passphrase (PBKDF2-SHA256, 310k rounds).
// Only ciphertext is written to disk (chrome.storage.local). The unlocked key lives in chrome.storage.session,
// which is memory-only and cleared when the browser closes.
(function (root) {
  'use strict';
  const DA = (root.DA = root.DA || {});
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ITER = 310000;

  const b64 = (buf) => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveKey(pass, saltB64) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(saltB64), iterations: ITER, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  async function encryptJSON(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function decryptJSON(key, box) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
    return JSON.parse(dec.decode(pt));
  }
  // Returns { meta, key }: meta is what gets stored (salt + an encrypted check value).
  async function create(pass) {
    if (!pass || pass.length < 6) throw new Error('Passphrase must be at least 6 characters');
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveKey(pass, salt);
    return { meta: { v: 1, salt, check: await encryptJSON(key, { ok: 'dropassist' }) }, key };
  }
  async function unlock(meta, pass) {
    const key = await deriveKey(pass, meta.salt);
    try { const c = await decryptJSON(key, meta.check); if (c.ok !== 'dropassist') throw 0; } catch (_) { throw new Error('Wrong passphrase'); }
    return key;
  }
  const exportKey = async (key) => b64(await crypto.subtle.exportKey('raw', key));
  const importKey = (raw) => crypto.subtle.importKey('raw', unb64(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

  function cardBrand(num) {
    const n = String(num).replace(/\D/g, '');
    if (/^4/.test(n)) return 'Visa';
    if (/^(5[1-5]|2[2-7])/.test(n)) return 'Mastercard';
    if (/^3[47]/.test(n)) return 'Amex';
    if (/^6(011|5)/.test(n)) return 'Discover';
    return 'Card';
  }
  function luhn(num) {
    const d = String(num).replace(/\D/g, '');
    if (d.length < 12 || d.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let x = +d[d.length - 1 - i];
      if (i % 2) { x *= 2; if (x > 9) x -= 9; }
      sum += x;
    }
    return sum % 10 === 0;
  }
  // Normalize + validate what the user typed. exp accepts "MM/YY", "MM / YYYY", "MMYY".
  function normalizeCard(c) {
    const number = String(c.number || '').replace(/\D/g, '');
    if (!luhn(number)) throw new Error('Card number looks wrong (failed checksum)');
    const m = String(c.exp || '').replace(/\s/g, '').match(/^(\d{1,2})\/?(\d{2}|\d{4})$/);
    if (!m || +m[1] < 1 || +m[1] > 12) throw new Error('Expiry should look like 08/29');
    const mm = m[1].padStart(2, '0'), yy = m[2].slice(-2);
    const cvv = String(c.cvv || '').replace(/\D/g, '');
    if (cvv && !/^\d{3,4}$/.test(cvv)) throw new Error('CVV should be 3–4 digits');
    return { number, mm, yy, cvv, name: String(c.name || '').trim() };
  }

  DA.vault = { deriveKey, encryptJSON, decryptJSON, create, unlock, exportKey, importKey, cardBrand, luhn, normalizeCard };
  if (typeof module !== 'undefined' && module.exports) module.exports = DA.vault;
})(typeof self !== 'undefined' ? self : globalThis);
