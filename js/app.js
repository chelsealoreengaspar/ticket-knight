/* Ticket Knight - buyer app (screens 1-6) */
(function () {
  'use strict';
  const { sb, $, $$, esc, peso, rpc, toast, modal, closeModal } = TK;
  const ROWS = 'ABCDEFGH', COLS = 12, MAXT = 6;

  const freshOrder = () => ({ eventId: null, tier: null, qty: 1, seats: [], holdEnds: 0, taken: new Set(), owned: 0 });
  const S = {
    screen: 1, user: null, account: null, events: [],
    otp: { sent: false, expires: 0, token: null, verifiedContact: '' },
    order: freshOrder(), holders: [], hIdx: 0, summary: false, last: [], mine: [], transfers: []
  };

  // ---------- helpers ----------
  const evById = id => S.events.find(e => e.id === id);
  const tiersOf = id => (evById(id) || {}).event_tiers || [];
  const tierOf = (evId, code) => tiersOf(evId).find(t => t.code === code);
  const seatName = (r, c) => ROWS[r] + '-' + String(c + 1).padStart(3, '0');
  const seatRC = s => ({ r: ROWS.indexOf(s[0]), c: parseInt(s.slice(2), 10) - 1 });
  const evDay = ev => ev ? new Date(new Date(ev.starts_at).toLocaleString('en-US', { timeZone: 'Asia/Manila' })) : null;
  const salesOpen = ev => ev && new Date(ev.starts_at) > new Date();
  const maxQty = () => Math.max(0, MAXT - S.order.owned);
  function setErr(key, msg, prefix) {
    const box = $('#' + (prefix || 'f') + '-' + key); if (!box) return;
    box.classList.toggle('bad', !!msg); box.querySelector('.msg').textContent = msg || '';
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Please wait...'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }
  function needAccount() {
    if (S.account && S.account.verified_status) return true;
    if (S.user) { toast('Finish verifying your account first.'); go(2); }
    else { toast('Sign up or sign in to buy tickets.'); openSignIn(); }
    return false;
  }

  // ---------- navigation ----------
  function go(n) {
    S.screen = n;
    $$('.screen').forEach(el => el.classList.toggle('active', el.id === 's' + n));
    const b = $('#s' + n + ' .body'); if (b) b.scrollTop = 0;
    if (n === 1) renderS1();
    if (n === 2) renderS2();
    if (n === 3) enterS3();
    if (n === 4) renderS4();
    if (n === 5) renderS5();
    if (n === 6) loadMine();
  }
  $$('[data-go]').forEach(b => b.onclick = () => { const n = +b.dataset.go; if (n >= 3 && !needAccount()) return; go(n); });
  $$('[data-home]').forEach(b => b.onclick = () => go(1));

  // ---------- boot ----------
  async function loadEvents() {
    const { data, error } = await sb.from('events').select('*, event_tiers(*)').order('starts_at');
    if (error) throw new Error(error.message);
    data.forEach(e => e.event_tiers.sort((a, b) => b.price - a.price));
    S.events = data;
  }
  async function loadAccount() {
    S.account = null;
    if (!S.user) return;
    const { data } = await sb.from('accounts').select('*').eq('id', S.user.id).maybeSingle();
    S.account = data || null;
  }
  async function boot() {
    if (!TK.configured) {
      $('#setupNote').innerHTML = '<div class="setup"><b>Setup needed.</b> Open <code>js/config.js</code> and paste your Supabase Project URL, publishable key and public signing key. See README.md, Part 2.</div>';
      $('#welcomeEvents').innerHTML = '';
      renderS1(); return;
    }
    try { await loadEvents(); } catch (e) { $('#welcomeEvents').innerHTML = '<p class="msg">Could not load events: ' + esc(e.message) + '. Did you run supabase/schema.sql?</p>'; }
    const { data } = await sb.auth.getSession();
    S.user = data.session ? data.session.user : null;
    await loadAccount();
    renderS1();
    sb.auth.onAuthStateChange((event, session) => {
      S.user = session ? session.user : null;
      if (event === 'SIGNED_OUT') { S.account = null; go(1); }
    });
  }

  // ---------- SCREEN 1: Welcome ----------
  function renderS1() {
    const evs = S.events;
    if (TK.configured && evs.length) {
      $('#welcomeEvents').innerHTML = evs.map(e =>
        '<button type="button" class="ev' + (salesOpen(e) ? '' : ' closed') + '" data-ev="' + esc(e.id) + '" aria-label="' + esc(e.name + ', ' + TK.fmtDate(e.starts_at) + ', buy tickets') + '">' +
        TK.artHtml(e) + '<span class="tag">FEATURED EVENT</span><span class="go">' + (salesOpen(e) ? 'Get tickets' : 'Sales closed') + '</span>' +
        '<div class="txt"><h3>' + esc(e.name) + '</h3><p>' + esc(TK.fmtWhen(e.starts_at)) + '<br>' + esc(e.venue) + '</p></div></button>').join('');
      $$('#welcomeEvents .ev').forEach(b => b.onclick = () => {
        if (!needAccount()) return;
        const ev = evById(b.dataset.ev);
        if (!salesOpen(ev)) { toast('Ticket sales for this event have closed.'); return; }
        if (S.order.eventId !== ev.id) { releaseIfHeld(); S.order = freshOrder(); S.order.eventId = ev.id; }
        go(3);
      });
    } else if (TK.configured) {
      $('#welcomeEvents').innerHTML = '<p class="hint">No events yet. Add rows to the events table in Supabase.</p>';
    }
    const f = $('#s1foot');
    if (S.account) {
      $('#welcomeLine').innerHTML = 'WELCOME BACK, ' + esc(S.account.full_name.toUpperCase()) + '!<br>SECURE YOUR TICKET WITH TICKET KNIGHT';
      f.innerHTML = '<button class="btn" type="button" id="b1">Buy Tickets</button><button class="btn light" type="button" id="b2">My Tickets</button><button class="linkbtn" type="button" id="b3">Sign out</button>';
      $('#b1').onclick = () => go(3); $('#b2').onclick = () => go(6); $('#b3').onclick = signOut;
    } else if (S.user) {
      $('#welcomeLine').innerHTML = 'ALMOST THERE!<br>VERIFY YOUR ACCOUNT TO BUY TICKETS';
      f.innerHTML = '<button class="btn" type="button" id="b1">Finish Verification</button><button class="linkbtn" type="button" id="b3">Sign out</button>';
      $('#b1').onclick = () => go(2); $('#b3').onclick = signOut;
    } else {
      $('#welcomeLine').innerHTML = 'WELCOME CONCERT GOER!<br>SECURE YOUR TICKET WITH TICKET KNIGHT';
      f.innerHTML = '<button class="btn" type="button" id="b1">Sign Up</button><button class="linkbtn" type="button" id="b2">Sign In</button>';
      $('#b1').onclick = () => go(2); $('#b2').onclick = openSignIn;
      if (!TK.configured) { $('#b1').disabled = true; $('#b2').disabled = true; }
    }
  }
  function openSignIn() {
    modal('Sign in',
      '<div class="field"><label for="siE">Email</label><input id="siE" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
      '<div class="field"><label for="siP">Password</label><input id="siP" type="password" autocomplete="current-password" placeholder="Password"></div>' +
      '<div class="msg" id="siM" aria-live="polite"></div>',
      [{ label: 'Sign in', run: async () => {
          const { data, error } = await sb.auth.signInWithPassword({ email: $('#siE').value.trim(), password: $('#siP').value });
          if (error) { $('#siM').textContent = error.message === 'Invalid login credentials' ? 'No matching account. Check the email and password, or use Sign Up.' : error.message; return false; }
          S.user = data.user; await loadAccount(); return true;
        }, fn: () => {
          if (S.account) { toast('Signed in as ' + S.account.full_name); go(S.order.eventId ? 3 : 1); }
          else { toast('Please finish verifying your account.'); go(2); }
        } },
       { label: 'Create an account', cls: 'ghost', fn: () => go(2) },
       { label: 'Cancel', cls: 'light' }]);
  }
  async function signOut() {
    await releaseIfHeld();
    await sb.auth.signOut();
    S.user = null; S.account = null; S.order = freshOrder(); S.holders = []; S.last = [];
    resetS2Form(); go(1); toast('Signed out.');
  }

  // ---------- SCREEN 2: Create account + OTP ----------
  const F = { name: '#fName', contact: '#fContact', birth: '#fBirth', email: '#fEmail', pass: '#fPass', idtype: '#fIdType', idno: '#fIdNo' };
  const completing = () => !!S.user && !S.account;
  function resetS2Form() {
    Object.keys(F).forEach(k => { $(F[k]).value = ''; setErr(k, ''); });
    S.otp = { sent: false, expires: 0, token: null, verifiedContact: '' };
    $('#otpIn').value = ''; $('#otpMsg').textContent = ''; $('#regMsg').textContent = ''; updateOtpUi();
  }
  function isVerified() { return !!S.otp.token && TK.normPhone($('#fContact').value) === S.otp.verifiedContact; }
  function updateOtpUi() {
    const ok = TK.phoneOk($('#fContact').value), v = isVerified();
    $('#sendOtp').disabled = !ok || v || !TK.configured;
    $('#resend').disabled = !S.otp.sent || v;
    $('#otpIn').disabled = !S.otp.sent || v;
    if (v) $('#otpHint').textContent = 'Contact number verified.';
    else if (S.otp.sent) { const left = S.otp.expires - Date.now(); $('#otpHint').textContent = left > 0 ? 'Code expires in ' + TK.mmss(left) : 'Code expired. Tap Resend.'; }
    else $('#otpHint').textContent = ok ? 'Tap Send OTP to receive a code.' : 'Enter a valid contact number to request a code.';
    const c = $('#vChip'); c.textContent = v ? 'Verified' : 'Unverified'; c.classList.toggle('ok', v);
    $('#register').disabled = !v;
    $('#regHint').textContent = v ? 'Contact verified. You can register now.' : 'Verify your contact number to enable Register.';
  }
  function renderS2() {
    const comp = completing();
    $('#regLead').textContent = comp ? 'Signed in as ' + S.user.email + '. Finish verifying your account to buy tickets.' : 'Enter your details and verify your account.';
    $('#fEmail').disabled = comp; if (comp) $('#fEmail').value = S.user.email;
    $('#f-pass').classList.toggle('hide', comp);
    $('#register').textContent = comp ? 'Verify Account' : 'Register';
    updateOtpUi();
  }
  async function sendOtp() {
    const v = $('#fContact').value;
    if (!TK.phoneOk(v)) { setErr('contact', 'Enter a valid mobile number, for example +63 917 123 4567.'); return; }
    setErr('contact', ''); busy($('#sendOtp'), true, 'Sending');
    try {
      const r = await rpc('request_otp', { p_contact: v });
      if (!r.ok) { setErr('contact', r.error); return; }
      S.otp = { sent: true, expires: Date.parse(r.expires_at), token: null, verifiedContact: '' };
      $('#otpIn').value = ''; $('#otpMsg').textContent = '';
      const s = $('#sms');
      s.innerHTML = '<b>SMS (SIMULATED)</b>Ticket Knight: your verification code is <strong>' + esc(r.code) + '</strong>. It expires in 5 minutes.<button type="button" aria-label="Dismiss message">&times;</button>';
      s.classList.remove('hide'); s.querySelector('button').onclick = () => s.classList.add('hide');
      clearTimeout(sendOtp.t); sendOtp.t = setTimeout(() => s.classList.add('hide'), 20000);
    } catch (e) { setErr('contact', e.message); }
    finally { busy($('#sendOtp'), false); updateOtpUi(); if (S.otp.sent) $('#otpIn').focus(); }
  }
  $('#sendOtp').onclick = sendOtp; $('#resend').onclick = sendOtp;
  $('#fContact').addEventListener('input', () => { setErr('contact', ''); updateOtpUi(); });
  $('#otpIn').addEventListener('input', async e => {
    const v = e.target.value.replace(/\D/g, ''); e.target.value = v; $('#otpMsg').textContent = '';
    if (v.length !== 6) return;
    try {
      const r = await rpc('verify_otp', { p_contact: $('#fContact').value, p_code: v });
      if (!r.ok) { $('#otpMsg').textContent = r.error; return; }
      S.otp.token = r.token; S.otp.verifiedContact = TK.normPhone($('#fContact').value);
      $('#sms').classList.add('hide'); updateOtpUi();
    } catch (err) { $('#otpMsg').textContent = err.message; }
  });
  Object.keys(F).forEach(k => { $(F[k]).addEventListener('input', () => setErr(k, '')); $(F[k]).addEventListener('change', () => setErr(k, '')); });

  $('#register').onclick = async () => {
    Object.keys(F).forEach(k => setErr(k, '')); $('#regMsg').textContent = '';
    let first = null; const bad = (k, m) => { setErr(k, m); if (!first) first = k; };
    const comp = completing();
    const v = { name: $('#fName').value.trim(), contact: $('#fContact').value, birth: $('#fBirth').value,
      email: comp ? S.user.email : $('#fEmail').value.trim(), pass: $('#fPass').value, idt: $('#fIdType').value, idn: $('#fIdNo').value.trim() };
    const age = TK.ageOn(v.birth);
    if (v.name.length < 2) bad('name', 'Enter your full name.');
    if (isNaN(age) || age < 0 || age > 120) bad('birth', 'Enter a valid birthday.');
    if (!comp && !TK.emailOk(v.email)) bad('email', 'Enter a valid email address.');
    if (!comp && v.pass.length < 8) bad('pass', 'Use at least 8 characters.');
    if (!v.idt) bad('idtype', 'Choose an ID type.');
    if (!/^[A-Za-z0-9-]{6,20}$/.test(v.idn)) bad('idno', 'Enter a valid ID number (6 to 20 letters, numbers, or hyphens).');
    if (!isVerified()) bad('contact', 'Verify this number with the one-time password.');
    if (first) { const el = $(F[first]); el.scrollIntoView({ block: 'center' }); el.focus(); return; }

    const btn = $('#register'); busy(btn, true, 'Verifying');
    try {
      // FR-001(b): reject values already linked to another account
      const av = await rpc('check_availability', { p_contact: v.contact, p_email: v.email, p_id_number: v.idn });
      if (av.contact_taken) bad('contact', 'This number is already registered.');
      if (!comp && av.email_taken) bad('email', 'This email is already registered. Use Sign In.');
      if (av.id_taken) bad('idno', 'This ID number is already linked to another account.');
      if (first) { $(F[first]).focus(); return; }

      if (!comp) {
        const { data, error } = await sb.auth.signUp({ email: v.email, password: v.pass });
        if (error) throw error;
        if (!data.session) {
          modal('Confirm your email first', 'Supabase sent a confirmation link to ' + esc(v.email) + '. Open it, then come back and Sign In to finish verification.<br><br><b>Tip for this project:</b> turn off <i>Confirm email</i> in Supabase (see README Part 2) to skip this step.', [{ label: 'OK' }]);
          return;
        }
        S.user = data.user;
      }
      const r = await rpc('complete_registration', { p_full_name: v.name, p_contact: v.contact, p_birthday: v.birth,
        p_id_type: v.idt, p_id_number: v.idn, p_otp_token: S.otp.token });
      if (!r.ok) { bad(r.field || 'name', r.error); if (!r.field) $('#regMsg').textContent = r.error; $(F[r.field] || '#fName').focus(); return; }
      await loadAccount();
      resetS2Form();
      toast('Account verified. ID validated by the verification service.');
      go(S.order.eventId ? 3 : 1);
    } catch (e) { $('#regMsg').textContent = e.message; }
    finally { busy(btn, false); updateOtpUi(); }
  };

  // ---------- SCREEN 3: Select seats ----------
  async function enterS3() {
    if (!S.account) { go(1); return; }
    renderS3();
    if (S.order.eventId) await refreshEvent();
  }
  async function ownedCount(evId) {
    const { count, error } = await sb.from('tickets').select('id', { count: 'exact', head: true })
      .eq('event_id', evId).eq('owner_account_id', S.user.id).in('status', ['PENDING', 'ACTIVE', 'USED']);
    if (error) throw new Error(error.message);
    return count || 0;
  }
  async function refreshEvent() {
    const o = S.order; if (!o.eventId) return;
    try {
      const [map, cnt] = await Promise.all([rpc('get_seat_map', { p_event: o.eventId }), ownedCount(o.eventId)]);
      o.taken = new Set(map.taken || []); o.owned = cnt;
      const mine = map.mine || [];
      if (mine.length && !o.seats.length) {  // resume an active hold (e.g. after a refresh)
        o.seats = mine; o.tier = map.mine_tier; o.qty = mine.length; o.holdEnds = Date.parse(map.mine_expires);
      }
      if (!mine.length && o.seats.length) { o.seats = []; o.holdEnds = 0; }
      if (o.qty > maxQty()) o.qty = Math.max(1, maxQty());
    } catch (e) { $('#s3msg').textContent = e.message; }
    renderS3();
  }
  async function releaseIfHeld() {
    const o = S.order;
    if (o.eventId && o.seats.length && sb) { try { await rpc('release_holds', { p_event: o.eventId }); } catch (e) { /* ignore */ } }
  }
  async function selectEvent(id) {
    const o = S.order; if (o.eventId === id) return;
    if (!salesOpen(evById(id))) { toast('Ticket sales for this event have closed.'); return; }
    await releaseIfHeld();
    const keepTier = o.tier;
    S.order = freshOrder(); S.order.eventId = id;
    if (keepTier && tierOf(id, keepTier)) S.order.tier = keepTier;
    $('#s3msg').textContent = '';
    await refreshEvent();
    if (S.order.tier) autoAssign();
  }
  function freeSeat(r, c) { return !S.order.taken.has(seatName(r, c)); }
  function tierRows(code) { const t = tierOf(S.order.eventId, code); return t ? t.row_letters.split('').map(l => ROWS.indexOf(l)) : []; }
  function autoAssign(retried) {
    const o = S.order; o.seats = []; $('#s3msg').textContent = '';
    if (!o.eventId || !o.tier || o.qty < 1) { hold(); return; }
    const n = o.qty; let pick = null;
    for (const r of tierRows(o.tier)) {   // best block of n adjacent seats, closest to centre
      const starts = []; for (let s = 0; s + n <= COLS; s++) starts.push(s);
      starts.sort((a, b) => Math.abs(a + (n - 1) / 2 - 5.5) - Math.abs(b + (n - 1) / 2 - 5.5));
      for (const s of starts) { let ok = true; for (let k = 0; k < n; k++) if (!freeSeat(r, s + k)) { ok = false; break; }
        if (ok) { pick = []; for (let k = 0; k < n; k++) pick.push(seatName(r, s + k)); break; } }
      if (pick) break;
    }
    if (!pick) { const all = []; tierRows(o.tier).forEach(r => { for (let c = 0; c < COLS; c++) if (freeSeat(r, c)) all.push(seatName(r, c)); }); if (all.length >= n) pick = all.slice(0, n); }
    if (!pick) { o.holdEnds = 0; hold(); $('#s3msg').textContent = 'Not enough seats left in this tier. Try another tier or fewer tickets.'; return; }
    o.seats = pick; hold(retried);
  }
  async function hold(retried) {
    const o = S.order, seq = (hold.seq = (hold.seq || 0) + 1);
    renderS3();
    if (!o.seats.length) { o.holdEnds = 0; if (o.eventId) { try { await rpc('release_holds', { p_event: o.eventId }); } catch (e) { /* ignore */ } } renderS3(); return; }
    $('#s3next').disabled = true; $('#s3hint').textContent = 'Holding seats...';
    try {
      const r = await rpc('hold_seats', { p_event: o.eventId, p_tier: o.tier, p_seats: o.seats });
      if (seq !== hold.seq) return;
      if (r.ok) { o.holdEnds = Date.parse(r.expires_at); $('#s3msg').textContent = ''; }
      else {
        o.seats = []; o.holdEnds = 0; $('#s3msg').textContent = r.error;
        if (r.code === 'TAKEN' && !retried) { await refreshEvent(); autoAssign(true); return; }
        if (r.code === 'LIMIT') await refreshEvent();
      }
    } catch (e) { if (seq === hold.seq) { o.holdEnds = 0; $('#s3msg').textContent = e.message; } }
    if (seq === hold.seq) renderS3();
  }
  function onSeat(name) {
    const o = S.order, i = o.seats.indexOf(name);
    if (i >= 0) o.seats.splice(i, 1);
    else if (o.seats.length < o.qty) o.seats.push(name);
    else o.seats[o.seats.length - 1] = name;
    o.seats.sort(); hold();
  }
  function renderS3() {
    const o = S.order;
    $('#evCards').innerHTML = S.events.map(e => {
      const sel = o.eventId === e.id;
      return '<button type="button" class="ev' + (sel ? ' sel' : '') + (salesOpen(e) ? '' : ' closed') + '" data-ev="' + esc(e.id) + '" aria-pressed="' + sel + '">' + TK.artHtml(e) +
        (sel ? '<span class="badge">SELECTED</span>' : '') + '<div class="txt"><h3>' + esc(e.name) + '</h3><p>' + esc(TK.fmtWhen(e.starts_at) + ' - ' + e.venue) + '</p></div></button>';
    }).join('');
    $$('#evCards .ev').forEach(b => b.onclick = () => selectEvent(b.dataset.ev));
    $('#evDots').innerHTML = S.events.map(e => '<button type="button" aria-label="Show ' + esc(e.name) + '"><i></i></button>').join('');
    $$('#evDots button').forEach((b, i) => b.onclick = () => $$('#evCards .ev')[i].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }));
    syncEvDots();

    const tiers = o.eventId ? tiersOf(o.eventId) : (S.events[0] ? S.events[0].event_tiers : []);
    $('#tierTabs').innerHTML = tiers.map(t => '<button type="button" data-t="' + esc(t.code) + '" aria-pressed="' + (o.tier === t.code) + '"' + (o.eventId ? '' : ' disabled') + '>' + esc(t.label) + '<small>' + peso(t.price).replace('.00', '') + '</small></button>').join('');
    $$('#tierTabs button').forEach(b => b.onclick = () => { if (o.tier === b.dataset.t) return; o.tier = b.dataset.t; autoAssign(); });

    drawGrid(); updateQty(); updateHold();
  }
  function syncEvDots() { const c = $('#evCards'); const w = c.firstElementChild ? c.firstElementChild.offsetWidth + 10 : 1; const i = Math.round(c.scrollLeft / w); $$('#evDots i').forEach((d, k) => d.classList.toggle('on', k === i)); }
  $('#evCards').addEventListener('scroll', syncEvDots);
  function drawGrid() {
    const o = S.order, inTier = new Set(o.tier ? tierRows(o.tier) : []), mine = new Set(o.seats);
    let h = '';
    for (let r = 0; r < ROWS.length; r++) for (let c = 0; c < COLS; c++) {
      const n = seatName(r, c), taken = o.taken.has(n), a = mine.has(n), here = inTier.has(r);
      const cls = 's' + (a ? ' a' : taken ? ' t' : '') + (o.tier && !here ? ' x' : '');
      if (here && !taken && o.eventId) h += '<button type="button" class="' + cls + '" data-seat="' + n + '" aria-label="Seat ' + n + (a ? ', assigned to you' : ', available') + '"></button>';
      else h += '<i class="' + cls + '" title="' + n + '"></i>';
    }
    $('#grid').innerHTML = h;
    $$('#grid button').forEach(b => b.onclick = () => onSeat(b.dataset.seat));
    $('#seatLine').textContent = o.seats.length ? 'Assigned seats: ' + o.seats.join(', ') + (o.seats.length < o.qty ? ' - tap ' + (o.qty - o.seats.length) + ' more seat(s)' : '')
      : (o.eventId && o.tier ? 'Tap empty seats in your tier to choose.' : 'Choose a concert and a tier. Best seats are assigned automatically; tap an empty seat in your tier to change.');
  }
  function updateQty() {
    const o = S.order, mx = maxQty();
    $('#qVal').textContent = o.qty;
    $('#qMinus').disabled = o.qty <= 1; $('#qPlus').disabled = o.qty >= mx;
    $('#quota').textContent = o.eventId ? 'Tickets owned for this event: ' + o.owned + ' of ' + MAXT + (mx === 0 ? ' (limit reached)' : '') : '';
    const ready = o.eventId && o.tier && o.qty > 0 && o.seats.length === o.qty && o.holdEnds > Date.now();
    $('#s3next').disabled = !ready;
    $('#s3hint').textContent = ready ? '' : (o.eventId && mx === 0 ? 'You have reached the 6 ticket limit for this event.' : !o.eventId ? 'Choose a concert to continue.' : !o.tier ? 'Choose a tier to continue.' : '');
  }
  $('#qMinus').onclick = () => { if (S.order.qty > 1) { S.order.qty--; autoAssign(); } };
  $('#qPlus').onclick = () => {
    if (S.order.qty < maxQty()) { S.order.qty++; autoAssign(); }
    else $('#s3msg').textContent = 'Maximum of 6 tickets per account for this event. You can add up to ' + maxQty() + ' more.';
  };
  $('#s3next').onclick = () => {
    const n = S.order.qty;
    while (S.holders.length < n) S.holders.push({ name: '', contact: '', birth: '' });
    S.holders.length = n; S.hIdx = 0; S.summary = false; go(4);
  };
  function updateHold() {
    const o = S.order, t = o.seats.length && o.holdEnds ? 'Seat held: ' + TK.mmss(o.holdEnds - Date.now()) : 'Seat held: --:--';
    $('#holdChip').textContent = t; $('#holdChip4').textContent = t;
  }
  function holdExpired() {
    S.order.seats = []; S.order.holdEnds = 0; S.summary = false;
    modal('Seat hold expired', 'The 10 minute hold ended and the seats were released. Please choose your seats again.',
      [{ label: 'Select seats again', fn: () => go(3) }]);
  }
  setInterval(() => {
    const o = S.order;
    if ((S.screen === 3 || S.screen === 4) && o.seats.length && o.holdEnds) {
      updateHold();
      if (Date.now() > o.holdEnds && $('#overlay').classList.contains('hide')) holdExpired();
    }
    if (S.screen === 2 && S.otp.sent && !isVerified()) updateOtpUi();
  }, 1000);

  // ---------- SCREEN 4: Review ----------
  const curHolder = () => S.holders[S.hIdx];
  function loadHolder() {
    const h = curHolder(), ev = evById(S.order.eventId);
    $('#hName').value = h.name; $('#hContact').value = h.contact; $('#hBirth').value = h.birth;
    ['name', 'contact', 'birth'].forEach(k => setErr(k, '', 'h'));
    $('#hCount').textContent = 'Holder ' + (S.hIdx + 1) + ' of ' + S.holders.length;
    $('#hSeat').textContent = 'Seat ' + (S.order.seats[S.hIdx] || '');
    $('#ageNote').textContent = ev && ev.minimum_age ? 'Each holder must be at least ' + ev.minimum_age + ' years old on the event date.' : '';
    $('#nextHolder').disabled = S.hIdx >= S.holders.length - 1;
    $('#prevHolder').classList.toggle('hide', S.hIdx === 0);
  }
  function validHolder(i, show) {
    const h = S.holders[i], ev = evById(S.order.eventId); let ok = true;
    const bad = (k, m) => { ok = false; if (show && i === S.hIdx) setErr(k, m, 'h'); };
    if (h.name.trim().length < 2) bad('name', 'Enter the holder name.');
    if (!TK.phoneOk(h.contact)) bad('contact', 'Enter a valid mobile number.');
    const a = TK.ageOn(h.birth, evDay(ev));
    if (isNaN(a) || TK.ageOn(h.birth) < 0) bad('birth', 'Enter a valid birthday.');
    else if (ev && a < ev.minimum_age) bad('birth', 'Holder must be at least ' + ev.minimum_age + ' years old for this event.');
    return ok;
  }
  function renderSummary() {
    const o = S.order, ev = evById(o.eventId), t = tierOf(o.eventId, o.tier), on = S.summary && ev && t;
    const d = '---';
    const rows = [['Event', on ? ev.name : d], ['Date', on ? TK.fmtWhen(ev.starts_at) : d], ['Tier', on ? t.label : d], ['Section', on ? t.section : d],
      ['Gate', on ? t.gate : d], ['Seat', on ? o.seats.join(', ') : d], ['Holders', on ? S.holders.map(h => h.name.trim()).join(', ') : d], ['Quantity', on ? o.qty : d]];
    $('#sum').innerHTML = rows.map(r => '<div><span>' + r[0] + '</span><span>' + esc(r[1]) + '</span></div>').join('') +
      '<div><span>Total</span><span>' + (on ? peso(t.price * o.qty) : d) + '</span></div>';
    $('#generate').disabled = !on;
  }
  function renderS4() {
    if (!S.order.seats.length) { go(3); return; }
    loadHolder(); renderSummary(); updateHold(); $('#s4msg').textContent = '';
  }
  function saveField(k, v) { curHolder()[k] = v; S.summary = false; renderSummary(); }
  $('#hName').addEventListener('input', e => { saveField('name', e.target.value); setErr('name', '', 'h'); });
  $('#hContact').addEventListener('input', e => { saveField('contact', e.target.value); setErr('contact', '', 'h'); });
  $('#hBirth').addEventListener('input', e => { saveField('birth', e.target.value); setErr('birth', '', 'h'); });
  $('#nextHolder').onclick = () => { if (!validHolder(S.hIdx, true)) return; S.hIdx++; loadHolder(); $('#hName').focus(); };
  $('#prevHolder').onclick = () => { if (S.hIdx > 0) { S.hIdx--; loadHolder(); } };
  $('#useMe').onclick = () => {
    const a = S.account; if (!a) return;
    Object.assign(curHolder(), { name: a.full_name, contact: TK.fmtPhone(a.contact_number), birth: a.birthday });
    S.summary = false; loadHolder(); renderSummary();
  };
  $('#viewSum').onclick = () => {
    if (!validHolder(S.hIdx, true)) return;
    for (let i = 0; i < S.holders.length; i++) {
      if (!validHolder(i, false)) { S.hIdx = i; loadHolder(); validHolder(i, true); $('#s4msg').textContent = 'Complete the details for holder ' + (i + 1) + ' of ' + S.holders.length + ' first.'; return; }
    }
    S.summary = true; $('#s4msg').textContent = ''; renderSummary();
    $('#sumHead').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#edit').onclick = () => {
    modal('What would you like to edit?', 'Account details are locked after verification (one verified account per person).', [
      { label: 'Holder details', fn: () => { S.summary = false; renderSummary(); S.hIdx = 0; loadHolder(); $('#hName').focus(); } },
      { label: 'Concert, tier, seats or quantity', fn: () => go(3) },
      { label: 'Cancel', cls: 'ghost' }]);
  };
  $('#generate').onclick = async () => {
    const o = S.order;
    if (!o.holdEnds || Date.now() > o.holdEnds) { holdExpired(); return; }
    const btn = $('#generate'); busy(btn, true, 'Generating');
    try {
      const r = await rpc('finalize_order', { p_event: o.eventId,
        p_holders: S.holders.map(h => ({ name: h.name.trim(), contact: h.contact, birthday: h.birth })) });
      if (!r.ok) {
        if (r.code === 'HOLD_EXPIRED') { holdExpired(); return; }
        if (r.code && r.code.indexOf('HOLDER_') === 0) { S.hIdx = +r.code.slice(7); S.summary = false; loadHolder(); renderSummary(); setErr(r.field, r.error, 'h'); }
        $('#s4msg').textContent = r.error; return;
      }
      let signedOk = true;
      try { await TK.signPending(); } catch (e) { signedOk = false; toast('Tickets saved, but signing failed: ' + e.message + ' Open My Tickets to retry.'); }
      const { data, error } = await sb.from('tickets').select(TK.TICKET_SELECT).in('id', r.ticket_ids).order('seat');
      if (error) throw new Error(error.message);
      S.last = data; S.lastSigned = signedOk;
      S.order = Object.assign(freshOrder(), { eventId: o.eventId }); S.holders = []; S.summary = false;
      go(5);
    } catch (e) { $('#s4msg').textContent = e.message; }
    finally { busy(btn, false); renderSummary(); }
  };

  // ---------- SCREEN 5: Digital ticket ----------
  function renderS5() {
    const t = S.last;
    $('#s5status').innerHTML = S.lastSigned === false ? '<span style="color:#a1262b">Signing pending - retry in My Tickets</span>' : 'Ticket Ready<i aria-hidden="true"></i>';
    $('#tix').innerHTML = t.map((x, i) => TK.ticketCard(x, i, t.length)).join('');
    TK.paintQRs($('#tix'));
    $('#tixDots').innerHTML = t.length > 1 ? t.map((x, i) => '<button type="button" aria-label="Show ticket ' + (i + 1) + '"><i></i></button>').join('') : '';
    $$('#tixDots button').forEach((b, i) => b.onclick = () => $$('#tix .tk')[i].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }));
    syncTixDots();
  }
  function syncTixDots() { const c = $('#tix'); const i = c.clientWidth ? Math.round(c.scrollLeft / (c.clientWidth + 10)) : 0; $$('#tixDots i').forEach((d, k) => d.classList.toggle('on', k === i)); }
  $('#tix').addEventListener('scroll', syncTixDots);
  $('#another').onclick = () => go(3);
  $('#exit').onclick = () => go(1);

  // ---------- SCREEN 6: My tickets + transfers (FR-005) ----------
  async function loadMine() {
    const box = $('#mineBody');
    if (!S.account) { box.innerHTML = '<p class="empty">Sign in to see your tickets.</p>'; return; }
    box.innerHTML = '<p class="empty">Loading&hellip;</p>';
    try {
      const [t, tr] = await Promise.all([
        sb.from('tickets').select(TK.TICKET_SELECT).eq('owner_account_id', S.user.id).order('created_at', { ascending: false }),
        sb.from('ticket_transfers').select('*, events(name, starts_at)').or('from_account.eq.' + S.user.id + ',to_account.eq.' + S.user.id).order('created_at', { ascending: false })
      ]);
      if (t.error) throw new Error(t.error.message);
      if (tr.error) throw new Error(tr.error.message);
      S.mine = t.data; S.transfers = tr.data;
      renderMine();
    } catch (e) { box.innerHTML = '<p class="msg">' + esc(e.message) + '</p>'; }
  }
  const STATUS_CHIP = { ACTIVE: ['ok', 'Active'], PENDING: ['info', 'Signing pending'], USED: ['', 'Used'], REVOKED: ['bad', 'Revoked'], TRANSFERRED: ['bad', 'Transferred'] };
  function canTransfer(t) {
    const ev = t.events || {};
    return t.status === 'ACTIVE' && t.transferable && !t.parent_ticket_id &&
      new Date(ev.starts_at).getTime() - 24 * 3600e3 > Date.now() &&
      !S.transfers.some(x => x.from_account === S.user.id && x.event_id === t.event_id && (x.status === 'PENDING' || x.status === 'ACCEPTED'));
  }
  function renderMine() {
    const me = S.user.id, inc = S.transfers.filter(x => x.to_account === me && x.status === 'PENDING'),
      out = S.transfers.filter(x => x.from_account === me && x.status === 'PENDING'),
      pending = S.mine.some(t => t.status === 'PENDING');
    let h = '';
    if (pending) h += '<div class="setup">Some tickets are not signed yet. <button class="linkbtn" type="button" id="retrySign" style="padding:0;min-height:0">Retry signing</button></div>';
    if (inc.length) {
      h += '<div class="section-h">INCOMING TRANSFERS</div>' + inc.map(x =>
        '<div class="mt"><div class="row"><div><h4>' + esc(x.events ? x.events.name : x.event_id) + '</h4><p>From ' + esc(x.from_email) + ' &middot; Seat ' + esc(x.seat) + ' &middot; ' + esc(x.tier) + '</p><p>A new ticket will be issued in your name. Transferred tickets cannot be transferred again.</p></div></div>' +
        '<div class="acts"><button class="btn sm green" type="button" data-acc="' + x.id + '">Accept</button><button class="btn sm ghost" type="button" data-dec="' + x.id + '">Decline</button></div></div>').join('');
    }
    if (out.length) {
      h += '<div class="section-h">OUTGOING TRANSFERS</div>' + out.map(x =>
        '<div class="mt"><div class="row"><div><h4>' + esc(x.events ? x.events.name : x.event_id) + '</h4><p>To ' + esc(x.to_email) + ' &middot; Seat ' + esc(x.seat) + ' &middot; waiting for them to accept</p></div><span class="chip sm info">Pending</span></div>' +
        '<div class="acts"><button class="btn sm ghost" type="button" data-cancel="' + x.id + '">Cancel transfer</button></div></div>').join('');
    }
    h += '<div class="section-h">MY TICKETS</div>';
    if (!S.mine.length) h += '<p class="empty">No tickets yet.</p>';
    h += S.mine.map(t => {
      const ev = t.events || {}, hd = TK.holderOf(t) || {}, c = STATUS_CHIP[t.status] || ['', t.status];
      return '<div class="mt"><div class="row"><div><h4>' + esc(ev.name) + '</h4><p>' + esc(TK.fmtWhen(ev.starts_at)) + '</p><p>Seat ' + esc(t.seat) + ' &middot; ' + esc(t.tier) + ' &middot; ' + esc(t.assigned_gate) + '</p><p>' + esc(hd.holder_name) + ' &middot; ' + esc(t.reference) + (t.parent_ticket_id ? ' &middot; received by transfer' : '') + '</p></div><span class="chip sm ' + c[0] + '">' + c[1] + '</span></div>' +
        '<div class="acts"><button class="btn sm" type="button" data-view="' + t.id + '">View ticket</button>' +
        (canTransfer(t) ? '<button class="btn sm ghost" type="button" data-tr="' + t.id + '">Transfer</button>' : '') + '</div></div>';
    }).join('');
    h += '<p class="hint" style="margin-top:12px">Transfer rules: one ticket per event, once, to another verified account, until 24 hours before the event. The original barcode is revoked and a new one is issued to the recipient.</p>';
    $('#mineBody').innerHTML = h;

    const rs = $('#retrySign'); if (rs) rs.onclick = async () => { try { await TK.signPending(); toast('Tickets signed.'); } catch (e) { toast('Signing failed: ' + e.message); } loadMine(); };
    $$('[data-view]').forEach(b => b.onclick = () => {
      const t = S.mine.find(x => x.id === +b.dataset.view);
      const o = modal(t.reference, TK.ticketCard(t, 0, 1), [{ label: 'Close' }]);
      TK.paintQRs(o);
    });
    $$('[data-tr]').forEach(b => b.onclick = () => openTransfer(S.mine.find(x => x.id === +b.dataset.tr)));
    $$('[data-acc]').forEach(b => b.onclick = () => respond(+b.dataset.acc, true, b));
    $$('[data-dec]').forEach(b => b.onclick = () => respond(+b.dataset.dec, false, b));
    $$('[data-cancel]').forEach(b => b.onclick = async () => {
      busy(b, true); try { const r = await rpc('cancel_transfer', { p_transfer: +b.dataset.cancel }); toast(r.ok ? 'Transfer cancelled.' : r.error); } catch (e) { toast(e.message); }
      loadMine();
    });
  }
  function openTransfer(t) {
    modal('Transfer ticket ' + t.reference,
      'Seat ' + esc(t.seat) + ' &middot; ' + esc(t.tier) + '. You can transfer only <b>one</b> ticket for this event, and only once. The recipient must have a verified Ticket Knight account.' +
      '<div class="field" style="margin-top:12px"><label for="trE">Recipient email</label><input id="trE" type="email" placeholder="friend@example.com"></div><div class="msg" id="trM" aria-live="polite"></div>',
      [{ label: 'Send transfer', run: async () => {
          const r = await rpc('request_transfer', { p_ticket: t.id, p_recipient_email: $('#trE').value });
          if (!r.ok) { $('#trM').textContent = r.error; return false; }
          return true;
        }, fn: () => { toast('Transfer sent. It completes when the recipient accepts.'); loadMine(); } },
       { label: 'Cancel', cls: 'ghost' }]);
  }
  async function respond(id, accept, b) {
    busy(b, true);
    try {
      const r = await rpc('respond_transfer', { p_transfer: id, p_accept: accept });
      if (!r.ok) { toast(r.error); }
      else if (accept) {
        try { await TK.signPending(); toast('Transfer accepted. Your new signed ticket is ready.'); }
        catch (e) { toast('Accepted, but signing failed: ' + e.message); }
      } else toast('Transfer declined.');
    } catch (e) { toast(e.message); }
    loadMine();
  }
  $('#signOut6').onclick = signOut;

  // ---------- close (X) buttons ----------
  $$('[data-close]').forEach(b => b.onclick = () => {
    if (S.screen === 2) { go(1); return; }
    modal('Cancel this booking?', 'Any held seats will be released.', [
      { label: 'Cancel booking', fn: async () => { await releaseIfHeld(); S.order = freshOrder(); S.holders = []; S.summary = false; go(1); } },
      { label: 'Keep booking', cls: 'ghost' }]);
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#overlay').classList.contains('hide')) closeModal(); });

  boot();
})();
