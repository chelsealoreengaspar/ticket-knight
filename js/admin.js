/* Ticket Knight - administrator dashboard (FR-005 b-d, scope items 13-15) */
(function () {
  'use strict';
  const { sb, $, $$, esc, rpc, toast, modal } = TK;
  let tab = 'overview';

  async function staffRole() {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) return null;
    const { data } = await sb.from('staff').select('role').eq('user_id', s.session.user.id).maybeSingle();
    return data ? data.role : 'NONE';
  }
  async function boot() {
    if (!TK.configured) { $('#loginBox').classList.remove('hide'); $('#aM').textContent = 'Supabase is not configured. Edit js/config.js first.'; return; }
    const role = await staffRole();
    if (role === 'ADMIN') return showDash();
    $('#loginBox').classList.remove('hide');
    if (role) { $('#aM').textContent = 'This account is not an administrator.'; $('#signOut').classList.remove('hide'); }
  }
  $('#aGo').onclick = async () => {
    $('#aM').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: $('#aE').value.trim(), password: $('#aP').value });
    if (error) { $('#aM').textContent = error.message; return; }
    const role = await staffRole();
    if (role !== 'ADMIN') { $('#aM').textContent = 'Signed in, but this account is not in the staff table as ADMIN.'; $('#signOut').classList.remove('hide'); return; }
    showDash();
  };
  $('#aP').addEventListener('keydown', e => { if (e.key === 'Enter') $('#aGo').click(); });
  $('#signOut').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  function showDash() {
    $('#loginBox').classList.add('hide'); $('#dash').classList.remove('hide'); $('#signOut').classList.remove('hide');
    render();
  }
  $$('#tabs button').forEach(b => b.onclick = () => {
    tab = b.dataset.tab; $$('#tabs button').forEach(x => x.setAttribute('aria-pressed', x === b)); render();
  });

  const chip = s => {
    const m = { ACTIVE: 'ok', USED: '', PENDING: 'info', REVOKED: 'bad', TRANSFERRED: 'bad', GRANT: 'ok', DENY: 'bad', ACCEPTED: 'ok', DECLINED: '', CANCELLED: '', VOIDED: 'bad' };
    return '<span class="chip sm ' + (m[s] == null ? 'info' : m[s]) + '">' + esc(s) + '</span>';
  };
  const table = (heads, rows) => '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + heads.map(h => '<th>' + h + '</th>').join('') +
    '</tr></thead><tbody>' + (rows.length ? rows.join('') : '<tr><td colspan="' + heads.length + '" class="hint">Nothing here yet.</td></tr>') + '</tbody></table></div>';
  async function q(builder) { const { data, error } = await builder; if (error) throw new Error(error.message); return data; }

  async function render() {
    const v = $('#view'); v.innerHTML = '<div class="panel"><p class="hint">Loading&hellip;</p></div>';
    try { v.innerHTML = await VIEWS[tab](); bind(); }
    catch (e) { v.innerHTML = '<div class="panel"><p class="msg">' + esc(e.message) + '</p></div>'; }
  }

  const VIEWS = {
    async overview() {
      const [events, tickets, flags, transfers] = await Promise.all([
        q(sb.from('events').select('id, name, starts_at, venue').order('starts_at')),
        q(sb.from('tickets').select('event_id, status')),
        q(sb.from('activity_flags').select('id').eq('resolved', false)),
        q(sb.from('ticket_transfers').select('id').eq('status', 'PENDING'))
      ]);
      const count = (ev, st) => tickets.filter(t => t.event_id === ev && (!st || st.includes(t.status))).length;
      const live = tickets.filter(t => ['ACTIVE', 'USED', 'PENDING'].includes(t.status)).length;
      return '<div class="panel"><h2>At a glance</h2><div class="stats">' +
        '<div class="stat"><small>Live tickets</small><b>' + live + '</b></div>' +
        '<div class="stat"><small>Admitted (used)</small><b>' + tickets.filter(t => t.status === 'USED').length + '</b></div>' +
        '<div class="stat"><small>Open flags</small><b>' + flags.length + '</b></div>' +
        '<div class="stat"><small>Pending transfers</small><b>' + transfers.length + '</b></div></div></div>' +
        '<div class="panel"><h2>Events</h2>' + table(['Event', 'Date', 'Active', 'Used', 'Revoked / transferred', 'Seats left (of 96)'],
          events.map(e => '<tr><td><b>' + esc(e.name) + '</b><br><span class="hint">' + esc(e.venue) + '</span></td><td>' + esc(TK.fmtWhen(e.starts_at)) + '</td><td>' + count(e.id, ['ACTIVE']) + '</td><td>' + count(e.id, ['USED']) +
            '</td><td>' + count(e.id, ['REVOKED', 'TRANSFERRED']) + '</td><td>' + (96 - count(e.id, ['ACTIVE', 'USED', 'PENDING'])) + '</td></tr>')) + '</div>';
    },

    async flags() {
      const rows = await q(sb.from('activity_flags').select('*, accounts(email, full_name), events(name), tickets(reference, status)').order('created_at', { ascending: false }).limit(200));
      return '<div class="panel"><h2>Flagged transfer activity <span class="hint">Refused transfers, 3+ transfers to one recipient, transfers within 1 hour of purchase, double admissions</span></h2>' +
        table(['When', 'Reason', 'Account', 'Event', 'Ticket', 'Status', ''], rows.map(f =>
          '<tr><td>' + esc(TK.fmtStamp(f.created_at)) + '</td><td>' + esc(f.reason) + '</td><td>' + esc(f.accounts ? f.accounts.full_name + ' (' + f.accounts.email + ')' : '-') + '</td><td>' + esc(f.events ? f.events.name : '-') +
          '</td><td>' + (f.tickets ? esc(f.tickets.reference) + ' ' + chip(f.tickets.status) : '-') + '</td><td>' + (f.resolved ? chip('RESOLVED') : '<span class="chip sm bad">OPEN</span>') + '</td><td style="white-space:nowrap">' +
          (f.ticket_id && f.tickets && ['ACTIVE', 'PENDING'].includes(f.tickets.status) ? '<button class="btn sm red" data-revoke="' + f.ticket_id + '" data-ref="' + esc(f.tickets.reference) + '">Revoke</button> ' : '') +
          (f.resolved ? '' : '<button class="btn sm ghost" data-resolve="' + f.id + '">Mark reviewed</button>') + '</td></tr>')) + '</div>';
    },

    async tickets() {
      const rows = await q(sb.from('tickets').select('*, ticket_holders(holder_name, contact_number), accounts(email, full_name), events(name)').order('created_at', { ascending: false }).limit(300));
      VIEWS._tickets = rows;
      return '<div class="panel"><h2>Tickets</h2><div class="toolbar"><input id="tSearch" placeholder="Search reference, email, holder name, seat or serial" aria-label="Search tickets"></div><div id="tTable">' + ticketTable(rows) + '</div></div>';
    },

    async transfers() {
      const rows = await q(sb.from('ticket_transfers').select('*, events(name)').order('created_at', { ascending: false }).limit(200));
      return '<div class="panel"><h2>Ticket transfers</h2>' + table(['Requested', 'Event', 'Seat', 'From', 'To', 'Status', 'Decided'], rows.map(x =>
        '<tr><td>' + esc(TK.fmtStamp(x.created_at)) + '</td><td>' + esc(x.events ? x.events.name : x.event_id) + '</td><td>' + esc(x.seat) + ' (' + esc(x.tier) + ')</td><td>' + esc(x.from_email) + '</td><td>' + esc(x.to_email) +
        '</td><td>' + chip(x.status) + '</td><td>' + esc(TK.fmtStamp(x.decided_at)) + '</td></tr>')) + '</div>';
    },

    async history() {
      const rows = await q(sb.from('ticket_history').select('*, tickets(reference)').order('chain_no', { ascending: false }).limit(150));
      return '<div class="panel"><h2>Tamper-evident ticket history <button class="btn sm" id="verify" type="button">Verify chain integrity</button></h2><div id="verifyOut"></div>' +
        '<p class="hint">Every record stores the SHA-256 hash of the record before it. Editing or deleting any row breaks the chain, and the check above reports where.</p>' +
        table(['#', 'When', 'Ticket', 'Action', 'Details', 'Previous hash', 'Hash'], rows.map(h =>
          '<tr><td>' + h.chain_no + '</td><td>' + esc(TK.fmtStamp(h.created_at)) + '</td><td>' + esc(h.tickets ? h.tickets.reference : h.ticket_id) + '</td><td><b>' + esc(h.action_type) + '</b></td><td class="mono">' + esc(JSON.stringify(h.details)) +
          '</td><td class="mono">' + esc(h.previous_hash.slice(0, 12)) + '&hellip;</td><td class="mono">' + esc(h.current_hash.slice(0, 12)) + '&hellip;</td></tr>')) + '</div>';
    },

    async scans() {
      const [scans, sms] = await Promise.all([
        q(sb.from('scan_events').select('*, tickets(reference)').order('scanned_at', { ascending: false }).limit(150)),
        q(sb.from('sms_outbox').select('*').order('created_at', { ascending: false }).limit(150))
      ]);
      return '<div class="panel"><h2>Gate scans (synced from offline scanners)</h2>' + table(['Scanned', 'Synced', 'Gate', 'Ticket', 'Result', 'Reason'], scans.map(s =>
          '<tr><td>' + esc(TK.fmtStamp(s.scanned_at)) + '</td><td>' + esc(TK.fmtStamp(s.synced_at)) + '</td><td>' + esc(s.gate) + '</td><td>' + esc(s.tickets ? s.tickets.reference : (s.barcode_serial || '-')) + '</td><td>' + chip(s.result) + '</td><td>' + esc(s.reason || '') + '</td></tr>')) + '</div>' +
        '<div class="panel"><h2>SMS notifications (FR-004) <span class="hint">Gateway is out of scope; messages are logged as simulated</span></h2>' + table(['Created', 'To', 'Message', 'Delivery status'], sms.map(m =>
          '<tr><td>' + esc(TK.fmtStamp(m.created_at)) + '</td><td>' + esc(TK.fmtPhone(m.to_contact)) + '</td><td>' + esc(m.body) + '</td><td>' + chip(m.status) + '</td></tr>')) + '</div>';
    }
  };

  function ticketTable(rows) {
    return table(['Reference', 'Event', 'Seat', 'Holder', 'Owner', 'Status', 'Serial', ''], rows.map(t => {
      const h = TK.holderOf(t) || {};
      return '<tr><td><b>' + esc(t.reference) + '</b>' + (t.parent_ticket_id ? '<br><span class="hint">by transfer</span>' : '') + '</td><td>' + esc(t.events ? t.events.name : t.event_id) + '</td><td>' + esc(t.seat) + '<br><span class="hint">' + esc(t.tier) + ' &middot; ' + esc(t.assigned_gate) + '</span></td><td>' + esc(h.holder_name) +
        '</td><td>' + esc(t.accounts ? t.accounts.email : '') + '</td><td>' + chip(t.status) + '</td><td class="mono">' + esc(t.barcode_serial) + '</td><td>' +
        (['ACTIVE', 'PENDING'].includes(t.status) ? '<button class="btn sm red" data-revoke="' + t.id + '" data-ref="' + esc(t.reference) + '">Revoke</button>' : '') + '</td></tr>';
    }));
  }

  function bind() {
    $$('[data-revoke]').forEach(b => b.onclick = () => {
      modal('Revoke ' + b.dataset.ref + '?', 'The barcode goes on the revocation list. Scanners deny it as <b>revoked</b> after their next sync. This cannot be undone.' +
        '<div class="field" style="margin-top:12px"><label for="rR">Reason</label><input id="rR" placeholder="e.g. Suspected resale"></div><div class="msg"></div>',
        [{ label: 'Revoke barcode', cls: 'red', run: async () => {
            const r = await rpc('admin_revoke_ticket', { p_ticket: +b.dataset.revoke, p_reason: $('#rR').value });
            if (!r.ok) throw new Error(r.error);
          }, fn: () => { toast('Ticket revoked.'); render(); } },
         { label: 'Cancel', cls: 'ghost' }]);
    });
    $$('[data-resolve]').forEach(b => b.onclick = async () => {
      try { await rpc('admin_resolve_flag', { p_flag: +b.dataset.resolve }); render(); } catch (e) { toast(e.message); }
    });
    const s = $('#tSearch');
    if (s) s.oninput = () => {
      const k = s.value.trim().toLowerCase();
      const rows = VIEWS._tickets.filter(t => !k || [t.reference, t.seat, t.barcode_serial, (TK.holderOf(t) || {}).holder_name, t.accounts && t.accounts.email]
        .some(x => String(x || '').toLowerCase().includes(k)));
      $('#tTable').innerHTML = ticketTable(rows); bind();
    };
    const v = $('#verify');
    if (v) v.onclick = async () => {
      try {
        const r = await rpc('admin_verify_history');
        $('#verifyOut').innerHTML = r.ok
          ? '<div class="banner ok">Chain intact: ' + r.checked + ' records verified.</div>'
          : (r.error ? '<div class="banner bad">' + esc(r.error) + '</div>' : '<div class="banner bad">Integrity check FAILED at record #' + r.broken_at + ' (ticket id ' + r.ticket_id + '). The history was altered.</div>');
      } catch (e) { $('#verifyOut').innerHTML = '<div class="banner bad">' + esc(e.message) + '</div>'; }
    };
  }

  boot();
})();
