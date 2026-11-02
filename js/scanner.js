/* Ticket Knight - offline gate scanner (FR-003, FR-004 trigger, NFR-001, NFR-003)
 *
 * Validation runs 100% on this device:
 *   1. Ed25519 signature check with the PUBLIC key (js/config.js)
 *   2. event + assigned gate check
 *   3. revocation list check (downloaded bundle)
 *   4. local ledger check (tickets already admitted)
 * Results are queued in localStorage and synced when the network returns.
 */
(function () {
  'use strict';
  const { sb, $, esc, toast } = TK;
  const K = { cfg: 'tk_scanner_cfg', bundle: 'tk_scanner_bundle', ledger: 'tk_scanner_ledger', queue: 'tk_scanner_queue', recent: 'tk_scanner_recent' };
  const REASONS = {
    INVALID_SIGNATURE: 'Invalid signature: forged, altered or unreadable code',
    WRONG_EVENT: 'Wrong event: this ticket is for another event',
    WRONG_GATE: 'Wrong gate',
    REVOKED: 'Revoked barcode (transferred or revoked by an administrator)',
    ALREADY_USED: 'Already used: this ticket was already admitted',
    ID_MISMATCH: 'Presented ID does not match the ticket holder'
  };

  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Could not save on this device: ' + e.message); } };
  let cfg = load(K.cfg, null), bundle = load(K.bundle, null), ledger = load(K.ledger, {}), queue = load(K.queue, []), recent = load(K.recent, []);
  let revoked = new Set((bundle && bundle.revoked) || []);
  let PUB = null, lastValidCode = null, pending = null, busySync = false, cam = null, lastCode = '', lastCodeAt = 0;

  try { PUB = TK.fromB64url(TK.C.TK_PUBLIC_KEY); if (PUB.length !== 32) PUB = null; } catch (e) { PUB = null; }
  if (!PUB) $('#pkNote').innerHTML = '<span class="msg">TK_PUBLIC_KEY in js/config.js is missing or invalid. Generate it with tools/keygen.html.</span>';

  function show(id) { ['g1', 'g2'].forEach(x => $('#' + x).classList.toggle('active', x === id)); if (id === 'g2') renderStatus(); }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

  // ---------- setup ----------
  async function boot() {
    if (cfg && bundle) { show('g2'); trySync(); return; }
    if (!TK.configured) { $('#gM').textContent = 'Supabase is not configured. Edit js/config.js first.'; return; }
    const { data } = await sb.auth.getSession();
    if (data.session) openConfig();
  }
  $('#gLogin').onclick = async () => {
    $('#gM').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: $('#gE').value.trim(), password: $('#gP').value });
    if (error) { $('#gM').textContent = error.message; return; }
    openConfig();
  };
  $('#gP').addEventListener('keydown', e => { if (e.key === 'Enter') $('#gLogin').click(); });
  async function openConfig() {
    $('#loginCard').classList.add('hide'); $('#cfgCard').classList.remove('hide'); $('#cM').textContent = '';
    const { data } = await sb.auth.getSession();
    $('#whoami').textContent = data.session ? 'Signed in as ' + data.session.user.email : '';
    try {
      const b = await TK.rpc('get_scanner_bundle');
      if (!b.ok) { $('#cM').textContent = b.error + ' Ask an administrator to add you to the staff table (README Part 5).'; return; }
      $('#cEvent').innerHTML = b.events.map(e => '<option value="' + esc(e.id) + '">' + esc(e.name + ' - ' + TK.fmtDate(e.starts_at)) + '</option>').join('');
      $('#cGate').innerHTML = b.gates.map(g => '<option>' + esc(g) + '</option>').join('');
      if (cfg) { $('#cEvent').value = cfg.event; $('#cGate').value = cfg.gate; }
    } catch (e) { $('#cM').textContent = navigator.onLine ? e.message : 'You are offline. Setup needs a connection once.'; }
  }
  $('#cDownload').onclick = async () => {
    try {
      const b = await TK.rpc('get_scanner_bundle');
      if (!b.ok) { $('#cM').textContent = b.error; return; }
      const ev = b.events.find(e => e.id === $('#cEvent').value);
      cfg = { event: ev.id, eventName: ev.name, gate: $('#cGate').value };
      save(K.cfg, cfg); applyBundle(b); show('g2');
    } catch (e) { $('#cM').textContent = e.message; }
  };
  $('#cSignOut').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  $('#toSetup').onclick = () => {
    stopCam(); show('g1');
    if (TK.configured && navigator.onLine) sb.auth.getSession().then(r => { if (r.data.session) openConfig(); });
    else $('#gM').textContent = 'Offline: settings can be changed once the connection returns.';
  };

  function applyBundle(b) {
    bundle = { generated_at: b.generated_at, revoked: b.revoked, events: b.events };
    revoked = new Set(b.revoked);
    (b.used || []).forEach(u => { if (!ledger[u.tid]) ledger[u.tid] = { at: u.at, gate: 'other scanner', synced: true }; });
    save(K.bundle, bundle); save(K.ledger, ledger); renderStatus();
  }

  // ---------- status + sync ----------
  function renderStatus() {
    if (!cfg) return;
    const on = navigator.onLine;
    $('#netline').innerHTML =
      '<span class="chip sm ' + (on ? 'ok' : 'bad') + '">' + (on ? 'Online' : 'Offline mode') + '</span>' +
      '<span class="chip sm info">' + esc(cfg.gate) + '</span>' +
      '<span class="chip sm info">' + esc(cfg.eventName) + '</span>' +
      '<span class="chip sm ' + (queue.length ? 'hold' : '') + '">' + queue.length + ' to sync</span>' +
      '<span class="chip sm">' + Object.keys(ledger).length + ' in ledger</span>' +
      '<span class="chip sm">Data: ' + esc(bundle ? TK.fmtStamp(bundle.generated_at) : 'none') + '</span>';
    $('#recent').innerHTML = recent.length ? recent.slice(0, 8).map(r =>
      '<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid #c9d2e3"><span>' + esc(TK.fmtStamp(r.at)) + ' &middot; ' + esc(r.label) + '</span><span class="chip sm ' + (r.result === 'GRANT' ? 'ok' : 'bad') + '">' + r.result + '</span></div>').join('') : 'None yet.';
  }
  async function trySync(manual) {
    if (busySync || !TK.configured || !navigator.onLine) { if (manual) toast('Offline. Scans are queued and will sync automatically.'); renderStatus(); return; }
    busySync = true;
    try {
      const { data } = await sb.auth.getSession();
      if (!data.session) { if (manual) toast('Sign in again in settings to sync.'); return; }
      if (queue.length) {
        const batch = queue.slice(0, 200);
        const r = await TK.rpc('sync_scans', { p_events: batch });
        if (!r.ok) throw new Error(r.error);
        const sent = new Set(batch.map(x => x.id));
        queue = queue.filter(x => !sent.has(x.id)); save(K.queue, queue);
        Object.keys(ledger).forEach(k => { ledger[k].synced = true; }); save(K.ledger, ledger);
      }
      const b = await TK.rpc('get_scanner_bundle');
      if (b.ok) applyBundle(b);
      if (manual) toast('Synced with the central system.');
    } catch (e) { if (manual) toast('Sync failed: ' + e.message); }
    finally { busySync = false; renderStatus(); }
  }
  $('#syncBtn').onclick = () => trySync(true);
  window.addEventListener('online', () => trySync());
  window.addEventListener('offline', renderStatus);
  setInterval(() => trySync(), 30000);   // well inside the 5-minute sync requirement

  // ---------- validation ----------
  function decode(code) {
    const parts = String(code || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'TK1') return null;
    try {
      const msg = TK.fromB64url(parts[1]), sig = TK.fromB64url(parts[2]);
      return { msg, sig, payload: JSON.parse(new TextDecoder().decode(msg)) };
    } catch (e) { return null; }
  }
  const sigOk = d => !!(d && PUB && d.sig.length === 64 && nacl.sign.detached.verify(d.msg, d.sig, PUB));

  function validate(code) {
    if (!cfg) { toast('Finish setup first.'); return; }
    if (pending) { toast('Confirm or deny the current ticket first.'); return; }
    const t0 = performance.now();
    const d = decode(code);
    let reason = null;
    if (!sigOk(d)) reason = 'INVALID_SIGNATURE';
    else if (d.payload.ev !== cfg.event) reason = 'WRONG_EVENT';
    else if (d.payload.gate !== cfg.gate) reason = 'WRONG_GATE';
    else if (revoked.has(d.payload.ser)) reason = 'REVOKED';
    else if (ledger[d.payload.tid]) reason = 'ALREADY_USED';
    const ms = (performance.now() - t0).toFixed(1);
    const p = reason === 'INVALID_SIGNATURE' ? null : d.payload;
    if (reason) { record('DENY', reason, p); showResult('deny', reason, p, ms); return; }
    lastValidCode = code.trim();
    pending = p;
    showResult('wait', null, p, ms);
  }

  function record(result, reason, p) {
    const ev = { id: uuid(), ticket_id: p ? String(p.tid) : '', serial: p ? p.ser : '', event_id: cfg.event, gate: cfg.gate, result, reason, scanned_at: new Date().toISOString() };
    if (result === 'GRANT') { ledger[p.tid] = { at: ev.scanned_at, gate: cfg.gate, synced: false }; save(K.ledger, ledger); }
    queue.push(ev); save(K.queue, queue);
    recent.unshift({ at: ev.scanned_at, result, label: p ? p.ref + ' ' + p.name : 'unreadable code' }); recent = recent.slice(0, 30); save(K.recent, recent);
    renderStatus(); trySync();
  }

  function showResult(kind, reason, p, ms) {
    const who = p ? '<div class="who"><b>' + esc(p.name) + '</b>' + esc(p.tier) + ' &middot; Seat ' + esc(p.seat) + ' &middot; ' + esc(p.sec) + '<br>' + esc(p.ref) + ' &middot; ' + esc(p.gate) + '</div>' : '';
    let h;
    if (kind === 'wait') {
      h = '<div class="result wait"><h2>VALID</h2><p>Signature verified offline in ' + ms + ' ms. Check the holder\'s ID before admitting.</p>' + who +
        '<button class="btn green" id="okId" type="button">ID matches &middot; Admit</button><button class="btn red" id="badId" type="button">ID does not match &middot; Deny</button></div>';
    } else if (kind === 'grant') {
      h = '<div class="result grant"><h2>GRANT</h2><p>Entry recorded in the local ledger.</p>' + who + '</div>';
    } else {
      h = '<div class="result deny"><h2>DENY</h2><p>' + esc(REASONS[reason] || reason) + (reason === 'WRONG_GATE' && p ? ' - send to ' + esc(p.gate) : '') + '</p>' + who + (ms ? '<p style="opacity:.8;font-size:11px">Checked in ' + ms + ' ms</p>' : '') + '</div>';
    }
    $('#result').innerHTML = h;
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (kind === 'wait') {
      $('#okId').onclick = () => { const p2 = pending; pending = null; if (ledger[p2.tid]) { record('DENY', 'ALREADY_USED', p2); showResult('deny', 'ALREADY_USED', p2); return; } record('GRANT', null, p2); showResult('grant', null, p2); };
      $('#badId').onclick = () => { const p2 = pending; pending = null; record('DENY', 'ID_MISMATCH', p2); showResult('deny', 'ID_MISMATCH', p2); };
    }
  }

  $('#validateBtn').onclick = () => { const v = $('#manual').value; if (!v.trim()) return; validate(v); $('#manual').value = ''; };

  // ---------- camera ----------
  async function startCam() {
    if (!window.Html5Qrcode) { toast('Camera library not loaded. Paste the code instead.'); return; }
    cam = new Html5Qrcode('reader');
    try {
      await cam.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 230, height: 230 } }, txt => {
        const now = Date.now();
        if (pending || (txt === lastCode && now - lastCodeAt < 4000)) return;
        lastCode = txt; lastCodeAt = now; validate(txt);
      });
      $('#camBtn').textContent = 'Stop camera';
    } catch (e) { cam = null; toast('Camera unavailable: ' + (e.message || e) + '. Camera needs HTTPS (Vercel) or localhost.'); }
  }
  async function stopCam() { if (cam) { try { await cam.stop(); } catch (e) { /* ignore */ } cam = null; } $('#camBtn').textContent = 'Start camera'; }
  $('#camBtn').onclick = () => cam ? stopCam() : startCam();

  // ---------- NFR-003 tamper self-test ----------
  $('#tamperBtn').onclick = () => {
    const out = $('#tamperOut');
    if (!lastValidCode) { out.textContent = 'Validate one genuine ticket first, then run the test.'; return; }
    const d = decode(lastValidCode), base = d.payload, keys = Object.keys(base);
    const N = 1000, t0 = performance.now(); let rejected = 0, i = 0;
    const btn = $('#tamperBtn'); btn.disabled = true;
    (function chunk() {   // run in small batches so the scanner stays responsive
      const end = Math.min(N, i + 50);
      for (; i < end; i++) {
        const p = Object.assign({}, base), k = keys[i % keys.length], v = p[k];
        p[k] = typeof v === 'number' ? v + 1 + (i % 7) : String(v) + String.fromCharCode(65 + (i % 26));
        if (!nacl.sign.detached.verify(TK.utf8(JSON.stringify(p)), d.sig, PUB)) rejected++;
      }
      if (i < N) { out.textContent = 'Testing... ' + i + ' / ' + N; setTimeout(chunk, 0); return; }
      btn.disabled = false;
      const ms = (performance.now() - t0).toFixed(0);
      out.innerHTML = '<b style="color:' + (rejected === N ? '#14552e' : '#a1262b') + '">' + rejected + ' of ' + N + ' altered barcodes rejected</b> (' + keys.length + ' fields tested, ' + ms + ' ms total).';
    })();
  };

  boot();
})();
