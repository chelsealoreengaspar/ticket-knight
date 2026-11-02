/* Ticket Knight - shared helpers used by index.html, admin.html and scanner.html */
(function () {
  'use strict';
  // Custom logo: if img/logo.png exists it replaces the knight icon everywhere.
  (function () {
    const img = new Image();
    img.onload = () => document.documentElement.classList.add('has-logo');
    img.src = 'img/logo.png';
  })();

  const C = window.TK_CONFIG || {};
  const configured = !!(C.SUPABASE_URL && C.SUPABASE_ANON_KEY && !/YOUR-/i.test(C.SUPABASE_URL + C.SUPABASE_ANON_KEY));
  const sb = configured && window.supabase ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY) : null;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = n => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function normPhone(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (d.startsWith('09')) d = '63' + d.slice(1);
    if (d.length === 10 && d.startsWith('9')) d = '63' + d;
    return /^639\d{9}$/.test(d) ? d : '';
  }
  const phoneOk = v => !!normPhone(v);
  const fmtPhone = n => (n && n.length === 12) ? '+' + n.slice(0, 2) + ' ' + n.slice(2, 5) + ' ' + n.slice(5, 8) + ' ' + n.slice(8) : (n || '');
  const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

  // Age on a given date (defaults to today). Dates are 'YYYY-MM-DD'.
  function ageOn(iso, on) {
    if (!iso) return NaN;
    const d = new Date(iso + 'T00:00:00'); if (isNaN(d)) return NaN;
    const n = on ? new Date(on) : new Date();
    let a = n.getFullYear() - d.getFullYear();
    const m = n.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
    return a;
  }
  function mmss(ms) { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  const MNL = { timeZone: 'Asia/Manila' };
  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', Object.assign({ month: 'short', day: 'numeric', year: 'numeric' }, MNL));
  const fmtTime = iso => new Date(iso).toLocaleTimeString('en-US', Object.assign({ hour: 'numeric', minute: '2-digit' }, MNL));
  const fmtWhen = iso => iso ? fmtDate(iso) + ' - ' + fmtTime(iso) : '';
  const fmtStamp = iso => iso ? new Date(iso).toLocaleString('en-US', Object.assign({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }, MNL)) : '';

  // base64url <-> bytes
  function b64url(bytes) { let s = ''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function fromB64url(s) { const b = String(s).trim().replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(b + '='.repeat((4 - b.length % 4) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
  const utf8 = s => new TextEncoder().encode(s);

  // Calls a Postgres function. Throws on network/permission errors.
  async function rpc(name, args) {
    if (!sb) throw new Error('Supabase is not configured yet. Edit js/config.js.');
    const { data, error } = await sb.rpc(name, args || {});
    if (error) throw new Error(error.message);
    return data;
  }

  // Asks the sign-tickets Edge Function to sign all of the user's PENDING tickets.
  async function signPending() {
    const { data, error } = await sb.functions.invoke('sign-tickets', { body: {} });
    if (error) {
      let msg = error.message;
      try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return data;
  }

  function toast(t) {
    const el = $('#toast'); if (!el) return;
    el.textContent = t; el.classList.remove('hide');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hide'), 4000);
  }
  function closeModal() { const o = $('#overlay'); o.classList.add('hide'); o.innerHTML = ''; }
  // actions: [{label, cls, run: async () => false to keep open, fn: after close}]
  function modal(title, html, actions) {
    const o = $('#overlay');
    o.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><h2 id="mt">' + esc(title) + '</h2><div class="mb">' + html + '</div><div class="ma"></div></div>';
    const ma = o.querySelector('.ma');
    (actions || [{ label: 'OK' }]).forEach(a => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ' + (a.cls || ''); b.textContent = a.label;
      b.onclick = async () => {
        if (a.run) {
          b.disabled = true; let keep = false;
          try { keep = (await a.run()) === false; } catch (e) { keep = true; const m = o.querySelector('.msg'); if (m) m.textContent = e.message; }
          b.disabled = false; if (keep) return;
        }
        closeModal(); if (a.fn) a.fn();
      };
      ma.appendChild(b);
    });
    o.classList.remove('hide');
    const f = o.querySelector('input') || ma.querySelector('button'); if (f) f.focus();
    return o;
  }

  // ---------- tickets ----------
  const TICKET_SELECT = '*, ticket_holders(holder_name, contact_number), events(name, venue, starts_at, art, image_url)';
  const holderOf = t => Array.isArray(t.ticket_holders) ? t.ticket_holders[0] : t.ticket_holders;
  const qrText = t => 'TK1.' + b64url(utf8(t.payload)) + '.' + t.signature;
  function artHtml(ev) {
    ev = ev || {};
    return ev.image_url
      ? '<div class="art" style="background-image:url(\'' + esc(ev.image_url) + '\')"></div>'
      : '<div class="art ' + esc(ev.art || 'art-a') + '"></div>';
  }
  function ticketCard(t, i, n) {
    const ev = t.events || {}, h = holderOf(t) || {};
    const live = t.status === 'ACTIVE' && t.signature && t.payload;
    const stamp = { USED: 'USED', REVOKED: 'BARCODE REVOKED', TRANSFERRED: 'TRANSFERRED - BARCODE REVOKED', PENDING: 'SIGNING PENDING' }[t.status] || '';
    return '<article class="tk' + (live ? '' : ' void') + '" aria-label="Ticket ' + (i + 1) + ' of ' + n + '">' +
      '<div class="hd">' + artHtml(ev) + '<small>TICKET KNIGHT / ADMIT ONE</small><h3>' + esc(ev.name) + '</h3><p>' + esc(fmtWhen(ev.starts_at) + ' - ' + (ev.venue || '')) + '</p></div>' +
      '<div class="in"><div class="kv">' +
      '<div><small>Attendee</small><b>' + esc(h.holder_name) + '</b></div><div><small>Event</small><b>' + esc(ev.name) + '</b></div>' +
      '<div><small>Seat No.</small><b>' + esc(t.seat) + '</b></div><div><small>Tier</small><b>' + esc(t.tier) + '</b></div>' +
      '<div><small>Floor / Section</small><b>' + esc(t.section) + '</b></div><div><small>Gate</small><b>' + esc(t.assigned_gate) + '</b></div>' +
      '<div style="grid-column:1/-1"><small>Reference Number</small><b>' + esc(t.reference) + '</b></div></div>' +
      '<div class="qr" data-qr="' + (live ? esc(qrText(t)) : '') + '">' + (stamp ? '<em>' + esc(stamp) + '</em>' : '') + '</div>' +
      '<p class="cap">Present this signed ticket at ' + esc(t.assigned_gate) + ' with a valid ID matching the attendee name.</p></div></article>';
  }
  function paintQRs(root) {
    $$('[data-qr]', root).forEach(el => {
      const txt = el.dataset.qr;
      if (!txt || el.dataset.done || !window.QRCode) return;
      el.dataset.done = '1';
      new QRCode(el, { text: txt, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.L });
    });
  }

  window.TK = {
    C, sb, configured, $, $$, esc, peso, normPhone, phoneOk, fmtPhone, emailOk, ageOn, mmss,
    fmtDate, fmtTime, fmtWhen, fmtStamp, b64url, fromB64url, utf8, rpc, signPending,
    toast, modal, closeModal, TICKET_SELECT, holderOf, qrText, artHtml, ticketCard, paintQRs
  };
})();