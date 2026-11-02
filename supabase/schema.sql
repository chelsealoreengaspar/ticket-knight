-- =====================================================================
-- Ticket Knight: Secured Concert Event Ticketing System
-- Supabase database schema (run ONCE in Supabase > SQL Editor)
--
-- Maps to the Mini-SRS:
--   FR-001  accounts, otp_requests, request_otp, verify_otp,
--           check_availability, complete_registration, 6-ticket limit
--   FR-002  seat_holds (10-minute hold), finalize_order, ticket_holders,
--           tickets (signed by the sign-tickets Edge Function)
--   FR-003  get_scanner_bundle, sync_scans (offline scanner + ledger sync)
--   FR-004  sms_outbox (simulated SMS on every admitted / duplicate scan)
--   FR-005  ticket_transfers, request_transfer, respond_transfer,
--           ticket_history (hash chain), activity_flags, admin tools
--   NFR-002 passwords handled by Supabase Auth (hashed), government ID
--           stored only as a SHA-256 hash, Row Level Security everywhere
-- To start over, run supabase/reset.sql first.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------
create table public.accounts (
  id               uuid primary key references auth.users(id) on delete cascade,
  full_name        text not null check (char_length(full_name) between 2 and 100),
  contact_number   text not null unique,          -- normalized 639XXXXXXXXX
  email            text not null unique,
  birthday         date not null,                 -- age is computed from this
  id_type          text not null,
  id_number_hash   text not null unique,          -- SHA-256, never the raw ID
  verified_status  boolean not null default false,
  created_at       timestamptz not null default now()
);

create table public.staff (                       -- EventAdministrator / Gate Security
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('ADMIN','GATE')),
  created_at timestamptz not null default now()
);

create table public.events (
  id           text primary key,
  name         text not null,
  venue        text not null,
  starts_at    timestamptz not null,
  minimum_age  int not null default 0 check (minimum_age >= 0),
  art          text not null default 'art-a',     -- CSS art class when no image
  image_url    text,
  info_url     text
);

create table public.gate_scanners (
  scanner_id   int generated always as identity primary key,
  gate_number  text not null unique,
  label        text
);

create table public.event_tiers (
  event_id     text not null references public.events(id) on delete cascade,
  code         text not null,
  label        text not null,
  price        numeric(10,2) not null check (price >= 0),
  row_letters  text not null,                     -- e.g. 'AB' = rows A and B
  section      text not null,
  gate         text not null references public.gate_scanners(gate_number),
  primary key (event_id, code)
);

create table public.otp_requests (
  id          bigint generated always as identity primary key,
  contact     text not null,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  verified_at timestamptz,
  token       uuid unique,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table public.seat_holds (
  event_id    text not null references public.events(id) on delete cascade,
  seat        text not null,
  tier        text not null,
  account_id  uuid not null references public.accounts(id) on delete cascade,
  expires_at  timestamptz not null,
  primary key (event_id, seat)
);

create table public.purchase_orders (
  id            bigint generated always as identity primary key,
  account_id    uuid not null references public.accounts(id),
  event_id      text not null references public.events(id),
  ticket_count  int not null check (ticket_count between 1 and 6),
  created_at    timestamptz not null default now()
);

create table public.tickets (
  id                bigint generated always as identity primary key,
  reference         text unique,
  order_id          bigint references public.purchase_orders(id),
  event_id          text not null references public.events(id),
  owner_account_id  uuid not null references public.accounts(id),
  tier              text not null,
  section           text not null,
  seat              text not null,
  assigned_gate     text not null references public.gate_scanners(gate_number),
  barcode_serial    text not null unique default upper(replace(gen_random_uuid()::text, '-', '')),
  status            text not null default 'PENDING'
                    check (status in ('PENDING','ACTIVE','USED','REVOKED','TRANSFERRED')),
  transferable      boolean not null default true,
  parent_ticket_id  bigint references public.tickets(id),
  payload           text,                         -- exact signed JSON
  signature         text unique,                  -- Ed25519, base64url
  created_at        timestamptz not null default now(),
  used_at           timestamptz
);
-- one live ticket per seat per event
create unique index tickets_live_seat on public.tickets(event_id, seat)
  where status in ('PENDING','ACTIVE','USED');
create index tickets_owner on public.tickets(owner_account_id, event_id);

create table public.ticket_holders (
  id              bigint generated always as identity primary key,
  ticket_id       bigint not null unique references public.tickets(id) on delete cascade,
  holder_name     text not null,
  contact_number  text not null,
  birthday        date not null
);

create table public.ticket_transfers (
  id            bigint generated always as identity primary key,
  ticket_id     bigint not null references public.tickets(id),
  event_id      text not null references public.events(id),
  from_account  uuid not null references public.accounts(id),
  to_account    uuid not null references public.accounts(id),
  from_email    text not null,
  to_email      text not null,
  seat          text not null,
  tier          text not null,
  status        text not null default 'PENDING'
                check (status in ('PENDING','ACCEPTED','DECLINED','CANCELLED','VOIDED')),
  new_ticket_id bigint references public.tickets(id),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);

create table public.ticket_history (
  id             bigint generated always as identity primary key,
  chain_no       bigint unique,
  ticket_id      bigint not null references public.tickets(id),
  action_type    text not null,
  actor          uuid,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  previous_hash  text not null,
  current_hash   text not null
);

create table public.activity_flags (
  id           bigint generated always as identity primary key,
  account_id   uuid references public.accounts(id),
  event_id     text references public.events(id),
  ticket_id    bigint references public.tickets(id),
  reason       text not null,
  resolved     boolean not null default false,
  resolved_by  uuid,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);

create table public.scan_events (
  id               bigint generated always as identity primary key,
  client_event_id  uuid not null unique,          -- makes offline sync idempotent
  ticket_id        bigint references public.tickets(id),
  barcode_serial   text,
  event_id         text,
  gate             text,
  result           text not null check (result in ('GRANT','DENY')),
  reason           text,
  scanned_at       timestamptz not null,
  synced_at        timestamptz not null default now(),
  scanned_by       uuid
);

create table public.sms_outbox (
  id          bigint generated always as identity primary key,
  ticket_id   bigint references public.tickets(id),
  to_contact  text not null,
  body        text not null,
  status      text not null default 'QUEUED',
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

-- ---------------------------------------------------------------------
-- HELPER FUNCTIONS
-- ---------------------------------------------------------------------
create or replace function public.tk_hash(p text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$$;

create or replace function public.tk_norm_phone(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d like '09%' then d := '63' || substr(d, 2); end if;
  if length(d) = 10 and d like '9%' then d := '63' || d; end if;
  if d ~ '^639[0-9]{9}$' then return d; end if;
  return null;
end $$;

create or replace function public.tk_gov_id_hash(p text) returns text
language sql immutable set search_path = public as $$
  select public.tk_hash('gid:' || upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')))
$$;

-- Simulated "external verification service" for government IDs (FR-001).
create or replace function public.tk_validate_gov_id(p_type text, p_num text) returns boolean
language plpgsql immutable as $$
declare n text := upper(regexp_replace(coalesce(p_num, ''), '\s', '', 'g'));
begin
  if p_type not in ('Philippine National ID','Driver''s License','Passport','UMID','PRC ID') then
    return false;
  end if;
  return n ~ '^[A-Z0-9-]{6,20}$';
end $$;

create or replace function public.tk_err(p_msg text, p_field text default null, p_code text default null)
returns json language sql immutable as $$
  select json_build_object('ok', false, 'error', p_msg, 'field', p_field, 'code', p_code)
$$;

create or replace function public.tk_is_staff(p_roles text[] default array['ADMIN','GATE'])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where user_id = auth.uid() and role = any(p_roles))
$$;

create or replace function public.tk_owned(p_account uuid, p_event text) returns int
language sql stable set search_path = public as $$
  select count(*)::int from tickets
  where owner_account_id = p_account and event_id = p_event
    and status in ('PENDING','ACTIVE','USED')
$$;

create or replace function public.tk_age_on(p_birthday date, p_on date) returns int
language sql immutable as $$
  select extract(year from age(p_on, p_birthday))::int
$$;

create or replace function public.tk_log(p_ticket bigint, p_action text, p_actor uuid, p_details jsonb default '{}'::jsonb)
returns void language sql set search_path = public as $$
  insert into ticket_history(ticket_id, action_type, actor, details)
  values (p_ticket, p_action, p_actor, coalesce(p_details, '{}'::jsonb))
$$;

create or replace function public.tk_flag(p_account uuid, p_event text, p_ticket bigint, p_reason text)
returns void language sql set search_path = public as $$
  insert into activity_flags(account_id, event_id, ticket_id, reason)
  values (p_account, p_event, p_ticket, p_reason)
$$;

-- void every pending transfer once the 24-hour cut-off passes (FR-005e)
create or replace function public.tk_void_expired() returns void
language sql security definer set search_path = public as $$
  update ticket_transfers t set status = 'VOIDED', decided_at = now()
  from events e
  where t.event_id = e.id and t.status = 'PENDING'
    and now() > e.starts_at - interval '24 hours'
$$;

-- ---------------------------------------------------------------------
-- TRIGGERS: ticket reference + tamper-evident history chain
-- ---------------------------------------------------------------------
create or replace function public.tk_ticket_reference() returns trigger
language plpgsql as $$
begin
  new.reference := 'TK-' || to_char(now() at time zone 'Asia/Manila', 'YYYY') || '-' || lpad(new.id::text, 6, '0');
  return new;
end $$;
create trigger tickets_reference before insert on public.tickets
  for each row execute function public.tk_ticket_reference();

create or replace function public.tk_history_digest(
  p_chain bigint, p_ticket bigint, p_action text, p_actor uuid,
  p_details jsonb, p_at timestamptz, p_prev text)
returns text language sql stable set search_path = public as $$
  select public.tk_hash(concat_ws('|',
    p_chain::text, p_ticket::text, p_action, coalesce(p_actor::text, '-'),
    p_details::text, to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), p_prev))
$$;

create or replace function public.tk_history_chain() returns trigger
language plpgsql set search_path = public as $$
declare v_last ticket_history;
begin
  perform pg_advisory_xact_lock(424242);           -- one writer at a time
  select * into v_last from ticket_history order by chain_no desc limit 1;
  new.chain_no      := coalesce(v_last.chain_no, 0) + 1;
  new.previous_hash := coalesce(v_last.current_hash, repeat('0', 64));
  new.current_hash  := tk_history_digest(new.chain_no, new.ticket_id, new.action_type,
                                         new.actor, new.details, new.created_at, new.previous_hash);
  return new;
end $$;
create trigger ticket_history_chain before insert on public.ticket_history
  for each row execute function public.tk_history_chain();

-- ---------------------------------------------------------------------
-- FR-001: OTP, availability, registration
-- ---------------------------------------------------------------------
-- The SMS gateway is out of scope, so the code is returned to the app
-- and shown in a "simulated SMS" banner. Only its hash is stored.
create or replace function public.request_otp(p_contact text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_phone text := tk_norm_phone(p_contact);
  v_code  text;
  v_exp   timestamptz := now() + interval '5 minutes';
begin
  if v_phone is null then
    return tk_err('Enter a valid mobile number, for example +63 917 123 4567.', 'contact');
  end if;
  if exists (select 1 from accounts where contact_number = v_phone) then
    return tk_err('This number is already registered.', 'contact');
  end if;
  if (select count(*) from otp_requests where contact = v_phone
        and created_at > now() - interval '1 hour') >= 5 then
    return tk_err('Too many codes requested for this number. Try again in an hour.', 'contact');
  end if;
  v_code := lpad(floor(random() * 1000000)::int::text, 6, '0');
  insert into otp_requests(contact, code_hash, expires_at)
  values (v_phone, tk_hash(v_phone || ':' || v_code), v_exp);
  return json_build_object('ok', true, 'code', v_code, 'expires_at', v_exp, 'contact', v_phone);
end $$;

create or replace function public.verify_otp(p_contact text, p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_phone text := tk_norm_phone(p_contact);
  r otp_requests;
  v_token uuid;
begin
  select * into r from otp_requests
  where contact = v_phone and verified_at is null
  order by created_at desc limit 1;
  if not found then return tk_err('Tap Send OTP to request a code first.'); end if;
  if now() > r.expires_at then return tk_err('This code has expired. Tap Resend for a new one.'); end if;
  if r.attempts >= 5 then return tk_err('Too many wrong attempts. Tap Resend for a new code.'); end if;
  if r.code_hash <> tk_hash(v_phone || ':' || coalesce(p_code, '')) then
    update otp_requests set attempts = attempts + 1 where id = r.id;
    return tk_err('Incorrect code. Check the SMS and try again.');
  end if;
  v_token := gen_random_uuid();
  update otp_requests set verified_at = now(), token = v_token where id = r.id;
  return json_build_object('ok', true, 'token', v_token);
end $$;

create or replace function public.check_availability(p_contact text, p_email text, p_id_number text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'contact_taken', exists (select 1 from accounts where contact_number = tk_norm_phone(p_contact)),
    'email_taken',   exists (select 1 from accounts where lower(email) = lower(trim(p_email)))
                  or exists (select 1 from auth.users where lower(email) = lower(trim(p_email))),
    'id_taken',      exists (select 1 from accounts where id_number_hash = tk_gov_id_hash(p_id_number)))
$$;

create or replace function public.complete_registration(
  p_full_name text, p_contact text, p_birthday date,
  p_id_type text, p_id_number text, p_otp_token uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_phone text := tk_norm_phone(p_contact);
  v_idh   text := tk_gov_id_hash(p_id_number);
  r otp_requests;
begin
  if v_uid is null then return tk_err('Sign in first.'); end if;
  if exists (select 1 from accounts where id = v_uid) then
    return json_build_object('ok', true, 'already', true);
  end if;
  select email into v_email from auth.users where id = v_uid;
  if char_length(trim(coalesce(p_full_name, ''))) < 2 then
    return tk_err('Enter your full name.', 'name');
  end if;
  if p_birthday is null or p_birthday > current_date or p_birthday < current_date - interval '120 years' then
    return tk_err('Enter a valid birthday.', 'birth');
  end if;
  select * into r from otp_requests where token = p_otp_token;
  if not found or r.contact is distinct from v_phone or r.used_at is not null
     or r.verified_at < now() - interval '30 minutes' then
    return tk_err('Verify this number with the one-time password.', 'contact');
  end if;
  if not tk_validate_gov_id(p_id_type, p_id_number) then
    return tk_err('The verification service could not validate this ID. Check the type and number.', 'idno');
  end if;
  if exists (select 1 from accounts where contact_number = v_phone) then
    return tk_err('This number is already registered.', 'contact');
  end if;
  if exists (select 1 from accounts where id_number_hash = v_idh) then
    return tk_err('This ID number is already linked to another account.', 'idno');
  end if;
  insert into accounts(id, full_name, contact_number, email, birthday, id_type, id_number_hash, verified_status)
  values (v_uid, trim(p_full_name), v_phone, lower(v_email), p_birthday, p_id_type, v_idh, true);
  update otp_requests set used_at = now() where id = r.id;
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- FR-002: seat map, 10-minute holds, checkout
-- ---------------------------------------------------------------------
create or replace function public.get_seat_map(p_event text) returns json
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  delete from seat_holds where expires_at < now();
  return json_build_object(
    'taken', coalesce((select json_agg(seat) from (
                 select seat from tickets where event_id = p_event and status in ('PENDING','ACTIVE','USED')
                 union
                 select seat from seat_holds where event_id = p_event and account_id is distinct from v_uid) s), '[]'::json),
    'mine', coalesce((select json_agg(seat order by seat) from seat_holds
                      where event_id = p_event and account_id = v_uid), '[]'::json),
    'mine_tier', (select min(tier) from seat_holds where event_id = p_event and account_id = v_uid),
    'mine_expires', (select min(expires_at) from seat_holds where event_id = p_event and account_id = v_uid));
end $$;

create or replace function public.hold_seats(p_event text, p_tier text, p_seats text[]) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_acc accounts; v_ev events; v_tier event_tiers;
  v_seats text[]; v_n int; v_owned int; v_s text; v_conf text[];
  v_exp timestamptz := now() + interval '10 minutes';
begin
  select * into v_acc from accounts where id = v_uid;
  if not found or not v_acc.verified_status then
    return tk_err('Verify your account before buying tickets.', null, 'UNVERIFIED');
  end if;
  select * into v_ev from events where id = p_event;
  if not found then return tk_err('Event not found.'); end if;
  if v_ev.starts_at <= now() then return tk_err('Ticket sales for this event have closed.'); end if;
  select * into v_tier from event_tiers where event_id = p_event and code = p_tier;
  if not found then return tk_err('Choose a ticket tier.'); end if;

  select array_agg(distinct s order by s) into v_seats from unnest(p_seats) s;
  v_n := coalesce(array_length(v_seats, 1), 0);
  if v_n < 1 then return tk_err('Choose at least one seat.'); end if;

  v_owned := tk_owned(v_uid, p_event);
  if v_owned + v_n > 6 then
    return tk_err(format('Maximum of 6 tickets per account for this event. You can add up to %s more.',
                         greatest(0, 6 - v_owned)), null, 'LIMIT');
  end if;

  foreach v_s in array v_seats loop
    if v_s !~ '^[A-H]-[0-9]{3}$' then
      return tk_err('Seat ' || v_s || ' does not exist.');
    end if;
    if substr(v_s, 3)::int not between 1 and 12 or position(substr(v_s, 1, 1) in v_tier.row_letters) = 0 then
      return tk_err('Seat ' || v_s || ' is not part of the ' || v_tier.label || ' tier.');
    end if;
  end loop;

  delete from seat_holds where expires_at < now();
  delete from seat_holds where event_id = p_event and account_id = v_uid;

  select array_agg(seat) into v_conf from (
    select seat from tickets where event_id = p_event and status in ('PENDING','ACTIVE','USED') and seat = any(v_seats)
    union
    select seat from seat_holds where event_id = p_event and seat = any(v_seats)) c;
  if v_conf is not null then
    return tk_err('Seat ' || array_to_string(v_conf, ', ') || ' was just taken. Choose again.', null, 'TAKEN');
  end if;

  insert into seat_holds(event_id, seat, tier, account_id, expires_at)
  select p_event, s, p_tier, v_uid, v_exp from unnest(v_seats) s;
  return json_build_object('ok', true, 'seats', v_seats, 'expires_at', v_exp);
exception when unique_violation then
  return tk_err('One of those seats was just taken. Choose again.', null, 'TAKEN');
end $$;

create or replace function public.release_holds(p_event text) returns void
language sql security definer set search_path = public as $$
  delete from seat_holds where event_id = p_event and account_id = auth.uid()
$$;

-- Payment is out of scope (simulated). Creates PENDING tickets; the
-- sign-tickets Edge Function signs them and flips them to ACTIVE.
create or replace function public.finalize_order(p_event text, p_holders jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_acc accounts; v_ev events; v_tier event_tiers;
  v_seats text[]; v_tiers text[]; v_n int; v_order bigint; v_tid bigint;
  v_ids bigint[] := '{}'; v_h jsonb; v_bday date; i int;
begin
  select * into v_acc from accounts where id = v_uid;
  if not found or not v_acc.verified_status then
    return tk_err('Verify your account before buying tickets.', null, 'UNVERIFIED');
  end if;
  select * into v_ev from events where id = p_event;
  if not found then return tk_err('Event not found.'); end if;

  select array_agg(seat order by seat), array_agg(distinct tier)
    into v_seats, v_tiers
  from seat_holds where event_id = p_event and account_id = v_uid and expires_at > now();
  v_n := coalesce(array_length(v_seats, 1), 0);
  if v_n = 0 then
    return tk_err('Your 10 minute seat hold expired. Please choose your seats again.', null, 'HOLD_EXPIRED');
  end if;
  if array_length(v_tiers, 1) <> 1 then return tk_err('Held seats must all be in one tier.'); end if;
  select * into v_tier from event_tiers where event_id = p_event and code = v_tiers[1];

  if jsonb_typeof(p_holders) is distinct from 'array' or jsonb_array_length(p_holders) <> v_n then
    return tk_err(format('Enter exactly one ticket holder for each of the %s tickets.', v_n));
  end if;
  if tk_owned(v_uid, p_event) + v_n > 6 then
    return tk_err('Maximum of 6 tickets per account for this event.', null, 'LIMIT');
  end if;

  for i in 0 .. v_n - 1 loop
    v_h := p_holders -> i;
    if char_length(trim(coalesce(v_h->>'name', ''))) < 2 then
      return tk_err(format('Enter the name of holder %s.', i + 1), 'name', 'HOLDER_' || i);
    end if;
    if tk_norm_phone(v_h->>'contact') is null then
      return tk_err(format('Enter a valid mobile number for holder %s.', i + 1), 'contact', 'HOLDER_' || i);
    end if;
    begin v_bday := (v_h->>'birthday')::date; exception when others then v_bday := null; end;
    if v_bday is null or v_bday > current_date then
      return tk_err(format('Enter a valid birthday for holder %s.', i + 1), 'birth', 'HOLDER_' || i);
    end if;
    if tk_age_on(v_bday, (v_ev.starts_at at time zone 'Asia/Manila')::date) < v_ev.minimum_age then
      return tk_err(format('Holder %s must be at least %s years old for this event.', i + 1, v_ev.minimum_age),
                    'birth', 'HOLDER_' || i);
    end if;
  end loop;

  insert into purchase_orders(account_id, event_id, ticket_count)
  values (v_uid, p_event, v_n) returning id into v_order;

  for i in 1 .. v_n loop
    v_h := p_holders -> (i - 1);
    insert into tickets(order_id, event_id, owner_account_id, tier, section, seat, assigned_gate)
    values (v_order, p_event, v_uid, v_tier.label, v_tier.section, v_seats[i], v_tier.gate)
    returning id into v_tid;
    insert into ticket_holders(ticket_id, holder_name, contact_number, birthday)
    values (v_tid, trim(v_h->>'name'), tk_norm_phone(v_h->>'contact'), (v_h->>'birthday')::date);
    perform tk_log(v_tid, 'ISSUED', v_uid,
      jsonb_build_object('order', v_order, 'seat', v_seats[i], 'tier', v_tier.label));
    v_ids := v_ids || v_tid;
  end loop;

  delete from seat_holds where event_id = p_event and account_id = v_uid;
  return json_build_object('ok', true, 'order_id', v_order, 'ticket_ids', v_ids);
exception when unique_violation then
  return tk_err('A seat was taken before checkout finished. Please choose again.', null, 'HOLD_EXPIRED');
end $$;

-- ---------------------------------------------------------------------
-- FR-005: transfers + suspicious-activity flags
-- ---------------------------------------------------------------------
create or replace function public.request_transfer(p_ticket bigint, p_recipient_email text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_from accounts; v_to accounts; v_t tickets; v_ev events;
  v_cnt int; v_id bigint;
begin
  perform tk_void_expired();
  select * into v_from from accounts where id = v_uid;
  if not found or not v_from.verified_status then return tk_err('Verify your account first.'); end if;
  select * into v_t from tickets where id = p_ticket and owner_account_id = v_uid;
  if not found then return tk_err('Ticket not found.'); end if;
  select * into v_ev from events where id = v_t.event_id;

  if now() > v_ev.starts_at - interval '24 hours' then
    return tk_err('Transfers close 24 hours before the event starts.', null, 'WINDOW');
  end if;
  if v_t.status <> 'ACTIVE' then return tk_err('Only active tickets can be transferred.'); end if;

  -- refusals under FR-005(b) are flagged (no exception, so the flag is kept)
  if not v_t.transferable or v_t.parent_ticket_id is not null then
    perform tk_flag(v_uid, v_t.event_id, v_t.id, 'Refused: transfer of a ticket that was already transferred');
    return tk_err('This ticket was received by transfer and cannot be transferred again.', null, 'REFUSED');
  end if;
  if exists (select 1 from ticket_transfers where from_account = v_uid and event_id = v_t.event_id
             and status in ('PENDING','ACCEPTED')) then
    perform tk_flag(v_uid, v_t.event_id, v_t.id, 'Refused: second transfer by the same account for this event');
    return tk_err('You can transfer only one ticket per event, once.', null, 'REFUSED');
  end if;

  select * into v_to from accounts where lower(email) = lower(trim(coalesce(p_recipient_email, '')));
  if not found or not v_to.verified_status then
    return tk_err('No verified Ticket Knight account uses that email.', 'email');
  end if;
  if v_to.id = v_uid then return tk_err('You cannot transfer a ticket to yourself.', 'email'); end if;

  v_cnt := tk_owned(v_to.id, v_t.event_id)
         + (select count(*)::int from ticket_transfers
            where to_account = v_to.id and event_id = v_t.event_id and status = 'PENDING');
  if v_cnt + 1 > 6 then
    perform tk_flag(v_uid, v_t.event_id, v_t.id, 'Refused: transfer would push the recipient above 6 tickets');
    return tk_err('The recipient already has the maximum of 6 tickets for this event.', 'email', 'REFUSED');
  end if;
  if tk_age_on(v_to.birthday, (v_ev.starts_at at time zone 'Asia/Manila')::date) < v_ev.minimum_age then
    return tk_err(format('The recipient must be at least %s years old for this event.', v_ev.minimum_age), 'email');
  end if;

  insert into ticket_transfers(ticket_id, event_id, from_account, to_account, from_email, to_email, seat, tier)
  values (v_t.id, v_t.event_id, v_uid, v_to.id, v_from.email, v_to.email, v_t.seat, v_t.tier)
  returning id into v_id;
  perform tk_log(v_t.id, 'TRANSFER_REQUESTED', v_uid, jsonb_build_object('transfer', v_id, 'to', v_to.email));

  if (select count(*) from ticket_transfers where to_account = v_to.id and event_id = v_t.event_id
        and status in ('PENDING','ACCEPTED')) >= 3 then
    perform tk_flag(v_to.id, v_t.event_id, v_t.id, '3 or more transfers to the same recipient for this event');
  end if;
  if v_t.created_at > now() - interval '1 hour' then
    perform tk_flag(v_uid, v_t.event_id, v_t.id, 'Transfer requested within 1 hour of purchase');
  end if;
  return json_build_object('ok', true, 'transfer_id', v_id);
end $$;

create or replace function public.respond_transfer(p_transfer bigint, p_accept boolean) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_tr ticket_transfers; v_t tickets; v_me accounts; v_new bigint;
begin
  perform tk_void_expired();
  select * into v_tr from ticket_transfers where id = p_transfer and to_account = v_uid for update;
  if not found then return tk_err('Transfer not found.'); end if;
  if v_tr.status <> 'PENDING' then
    return tk_err(case when v_tr.status = 'VOIDED'
      then 'This transfer was voided because transfers close 24 hours before the event.'
      else 'This transfer is no longer pending.' end);
  end if;

  if not p_accept then
    update ticket_transfers set status = 'DECLINED', decided_at = now() where id = v_tr.id;
    perform tk_log(v_tr.ticket_id, 'TRANSFER_DECLINED', v_uid, jsonb_build_object('transfer', v_tr.id));
    return json_build_object('ok', true);
  end if;

  select * into v_me from accounts where id = v_uid;
  select * into v_t from tickets where id = v_tr.ticket_id for update;
  if v_t.status <> 'ACTIVE' then
    update ticket_transfers set status = 'VOIDED', decided_at = now() where id = v_tr.id;
    return tk_err('The ticket is no longer valid, so the transfer was voided.');
  end if;
  if tk_owned(v_uid, v_t.event_id) + 1 > 6 then
    perform tk_flag(v_uid, v_t.event_id, v_t.id, 'Refused: transfer would push the recipient above 6 tickets');
    return tk_err('You already have the maximum of 6 tickets for this event.', null, 'REFUSED');
  end if;

  -- revoke the original barcode, then issue a new signed ticket to the recipient
  update tickets set status = 'TRANSFERRED' where id = v_t.id;
  perform tk_log(v_t.id, 'TRANSFERRED_BARCODE_REVOKED', v_tr.from_account,
    jsonb_build_object('transfer', v_tr.id, 'to', v_me.email));

  insert into tickets(order_id, event_id, owner_account_id, tier, section, seat, assigned_gate, transferable, parent_ticket_id)
  values (v_t.order_id, v_t.event_id, v_uid, v_t.tier, v_t.section, v_t.seat, v_t.assigned_gate, false, v_t.id)
  returning id into v_new;
  insert into ticket_holders(ticket_id, holder_name, contact_number, birthday)
  values (v_new, v_me.full_name, v_me.contact_number, v_me.birthday);
  perform tk_log(v_new, 'ISSUED_BY_TRANSFER', v_uid,
    jsonb_build_object('transfer', v_tr.id, 'from', v_tr.from_email, 'parent_ticket', v_t.id));

  update ticket_transfers set status = 'ACCEPTED', decided_at = now(), new_ticket_id = v_new where id = v_tr.id;
  return json_build_object('ok', true, 'ticket_id', v_new);
end $$;

create or replace function public.cancel_transfer(p_transfer bigint) returns json
language plpgsql security definer set search_path = public as $$
declare v_tr ticket_transfers;
begin
  update ticket_transfers set status = 'CANCELLED', decided_at = now()
  where id = p_transfer and from_account = auth.uid() and status = 'PENDING'
  returning * into v_tr;
  if not found then return tk_err('Only your pending transfers can be cancelled.'); end if;
  perform tk_log(v_tr.ticket_id, 'TRANSFER_CANCELLED', auth.uid(), jsonb_build_object('transfer', v_tr.id));
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Administrator tools
-- ---------------------------------------------------------------------
create or replace function public.admin_revoke_ticket(p_ticket bigint, p_reason text) returns json
language plpgsql security definer set search_path = public as $$
declare v_t tickets;
begin
  if not tk_is_staff(array['ADMIN']) then return tk_err('Administrators only.'); end if;
  update tickets set status = 'REVOKED' where id = p_ticket and status in ('PENDING','ACTIVE')
  returning * into v_t;
  if not found then return tk_err('Only pending or active tickets can be revoked.'); end if;
  update ticket_transfers set status = 'VOIDED', decided_at = now()
  where ticket_id = p_ticket and status = 'PENDING';
  perform tk_log(p_ticket, 'REVOKED', auth.uid(),
    jsonb_build_object('reason', coalesce(nullif(trim(p_reason), ''), 'Revoked by administrator')));
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_resolve_flag(p_flag bigint) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not tk_is_staff(array['ADMIN']) then return tk_err('Administrators only.'); end if;
  update activity_flags set resolved = true, resolved_by = auth.uid(), resolved_at = now() where id = p_flag;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_verify_history() returns json
language plpgsql security definer set search_path = public as $$
declare r ticket_history; v_prev text := repeat('0', 64); v_n int := 0;
begin
  if not tk_is_staff(array['ADMIN']) then return tk_err('Administrators only.'); end if;
  perform tk_void_expired();
  for r in select * from ticket_history order by chain_no loop
    v_n := v_n + 1;
    if r.previous_hash <> v_prev
       or r.current_hash <> tk_history_digest(r.chain_no, r.ticket_id, r.action_type, r.actor,
                                              r.details, r.created_at, r.previous_hash) then
      return json_build_object('ok', false, 'checked', v_n, 'broken_at', r.chain_no, 'ticket_id', r.ticket_id);
    end if;
    v_prev := r.current_hash;
  end loop;
  return json_build_object('ok', true, 'checked', v_n);
end $$;

-- ---------------------------------------------------------------------
-- FR-003 / FR-004: offline gate scanner support
-- ---------------------------------------------------------------------
create or replace function public.get_scanner_bundle() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not tk_is_staff() then return tk_err('Gate staff only.'); end if;
  perform tk_void_expired();
  return json_build_object(
    'ok', true,
    'generated_at', now(),
    'events',  coalesce((select json_agg(json_build_object('id', id, 'name', name, 'starts_at', starts_at) order by starts_at) from events), '[]'::json),
    'gates',   coalesce((select json_agg(gate_number order by gate_number) from gate_scanners), '[]'::json),
    'revoked', coalesce((select json_agg(barcode_serial) from tickets where status in ('REVOKED','TRANSFERRED')), '[]'::json),
    'used',    coalesce((select json_agg(json_build_object('tid', id, 'at', used_at)) from tickets where status = 'USED'), '[]'::json));
end $$;

create or replace function public.tk_queue_sms(p_ticket bigint, p_outcome text, p_gate text, p_at timestamptz)
returns void language plpgsql set search_path = public as $$
declare v_ref text; v_ev text; v_to text;
begin
  select t.reference, e.name, h.contact_number into v_ref, v_ev, v_to
  from tickets t join events e on e.id = t.event_id
  join ticket_holders h on h.ticket_id = t.id where t.id = p_ticket;
  if v_to is null then return; end if;
  -- SMS gateway operation is out of scope: the message is logged as simulated.
  insert into sms_outbox(ticket_id, to_contact, body, status, sent_at)
  values (p_ticket, v_to,
    format('Ticket Knight: %s ticket %s was scanned and %s at %s on %s. Not you? Report it to support@ticketknight.test with your ticket reference.',
           v_ev, v_ref, p_outcome, p_gate, to_char(p_at at time zone 'Asia/Manila', 'Mon DD, YYYY HH12:MI AM')),
    'SIMULATED_SENT', now());
end $$;

create or replace function public.sync_scans(p_events jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare
  e jsonb; v_uid uuid := auth.uid(); v_ins int := 0;
  v_tid bigint; v_id bigint; v_at timestamptz; v_t tickets;
begin
  if not tk_is_staff() then return tk_err('Gate staff only.'); end if;
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    v_tid := nullif(e->>'ticket_id', '')::bigint;
    if v_tid is not null and not exists (select 1 from tickets where id = v_tid) then v_tid := null; end if;
    v_at := coalesce((e->>'scanned_at')::timestamptz, now());
    v_id := null;
    insert into scan_events(client_event_id, ticket_id, barcode_serial, event_id, gate, result, reason, scanned_at, scanned_by)
    values ((e->>'id')::uuid, v_tid, e->>'serial', e->>'event_id', e->>'gate', e->>'result', e->>'reason', v_at, v_uid)
    on conflict (client_event_id) do nothing
    returning id into v_id;
    if v_id is null then continue; end if;          -- already synced earlier
    v_ins := v_ins + 1;
    if v_tid is null then continue; end if;

    select * into v_t from tickets where id = v_tid for update;
    if e->>'result' = 'GRANT' then
      if v_t.status = 'ACTIVE' then
        update tickets set status = 'USED', used_at = v_at where id = v_tid;
      elsif v_t.status = 'USED' then
        perform tk_flag(v_t.owner_account_id, v_t.event_id, v_tid, 'Ticket admitted more than once by offline scanners');
      end if;
      perform tk_log(v_tid, 'SCAN_ADMITTED', v_uid, jsonb_build_object('gate', e->>'gate', 'at', v_at));
      perform tk_queue_sms(v_tid, 'ADMITTED', e->>'gate', v_at);
    elsif e->>'reason' = 'ALREADY_USED' then
      perform tk_log(v_tid, 'SCAN_DUPLICATE_DENIED', v_uid, jsonb_build_object('gate', e->>'gate', 'at', v_at));
      perform tk_queue_sms(v_tid, 'DENIED (already used)', e->>'gate', v_at);
    else
      perform tk_log(v_tid, 'SCAN_DENIED', v_uid, jsonb_build_object('gate', e->>'gate', 'reason', e->>'reason', 'at', v_at));
    end if;
  end loop;
  return json_build_object('ok', true, 'inserted', v_ins);
end $$;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.accounts         enable row level security;
alter table public.staff            enable row level security;
alter table public.events           enable row level security;
alter table public.gate_scanners    enable row level security;
alter table public.event_tiers      enable row level security;
alter table public.otp_requests     enable row level security;
alter table public.seat_holds       enable row level security;
alter table public.purchase_orders  enable row level security;
alter table public.tickets          enable row level security;
alter table public.ticket_holders   enable row level security;
alter table public.ticket_transfers enable row level security;
alter table public.ticket_history   enable row level security;
alter table public.activity_flags   enable row level security;
alter table public.scan_events      enable row level security;
alter table public.sms_outbox       enable row level security;

-- Read-only policies. Every write goes through the functions above.
create policy "events are public"  on public.events        for select to anon, authenticated using (true);
create policy "tiers are public"   on public.event_tiers   for select to anon, authenticated using (true);
create policy "gates are public"   on public.gate_scanners for select to anon, authenticated using (true);

create policy "own account or admin" on public.accounts for select to authenticated
  using (id = auth.uid() or public.tk_is_staff(array['ADMIN']));
create policy "own staff row" on public.staff for select to authenticated
  using (user_id = auth.uid());
create policy "own holds" on public.seat_holds for select to authenticated
  using (account_id = auth.uid());
create policy "own orders or admin" on public.purchase_orders for select to authenticated
  using (account_id = auth.uid() or public.tk_is_staff(array['ADMIN']));
create policy "own tickets or staff" on public.tickets for select to authenticated
  using (owner_account_id = auth.uid() or public.tk_is_staff());
create policy "own holders or staff" on public.ticket_holders for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id and t.owner_account_id = auth.uid())
         or public.tk_is_staff());
create policy "own transfers or admin" on public.ticket_transfers for select to authenticated
  using (from_account = auth.uid() or to_account = auth.uid() or public.tk_is_staff(array['ADMIN']));
create policy "own history or admin" on public.ticket_history for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id and t.owner_account_id = auth.uid())
         or public.tk_is_staff(array['ADMIN']));
create policy "admin flags" on public.activity_flags for select to authenticated
  using (public.tk_is_staff(array['ADMIN']));
create policy "staff scans" on public.scan_events for select to authenticated
  using (public.tk_is_staff());
create policy "admin sms" on public.sms_outbox for select to authenticated
  using (public.tk_is_staff(array['ADMIN']));

-- ---------------------------------------------------------------------
-- FUNCTION PERMISSIONS
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.request_otp(text)                        to anon, authenticated;
grant execute on function public.verify_otp(text, text)                   to anon, authenticated;
grant execute on function public.check_availability(text, text, text)     to anon, authenticated;
grant execute on function public.tk_is_staff(text[])                      to authenticated;
grant execute on function public.complete_registration(text, text, date, text, text, uuid) to authenticated;
grant execute on function public.get_seat_map(text)                       to authenticated;
grant execute on function public.hold_seats(text, text, text[])           to authenticated;
grant execute on function public.release_holds(text)                      to authenticated;
grant execute on function public.finalize_order(text, jsonb)              to authenticated;
grant execute on function public.request_transfer(bigint, text)           to authenticated;
grant execute on function public.respond_transfer(bigint, boolean)        to authenticated;
grant execute on function public.cancel_transfer(bigint)                  to authenticated;
grant execute on function public.admin_revoke_ticket(bigint, text)        to authenticated;
grant execute on function public.admin_resolve_flag(bigint)               to authenticated;
grant execute on function public.admin_verify_history()                   to authenticated;
grant execute on function public.get_scanner_bundle()                     to authenticated;
grant execute on function public.sync_scans(jsonb)                        to authenticated;

-- ---------------------------------------------------------------------
-- SEED DATA (edit freely)
-- ---------------------------------------------------------------------
insert into public.gate_scanners(gate_number, label) values
  ('GATE 1', 'Upper Box entrance'),
  ('GATE 2', 'Lower Box entrance'),
  ('GATE 3', 'Floor / VIP entrance'),
  ('GATE 4', 'General Admission entrance');

insert into public.events(id, name, venue, starts_at, minimum_age, art) values
  ('midnight-band-2026', 'The Midnight Band', 'MOA Arena, Manila', '2026-12-12 20:00:00+08', 12, 'art-a'),
  ('bruno-march-2027',   'Bruno March',       'MOA Arena, Manila', '2027-01-23 17:00:00+08', 0,  'art-b');

insert into public.event_tiers(event_id, code, label, price, row_letters, section, gate)
select e.id, t.code, t.label, t.price, t.rows, t.section, t.gate
from public.events e
cross join (values
  ('VIP', 'VIP',               2950, 'AB',  'Floor A',   'GATE 3'),
  ('LB',  'Lower Box',         2200, 'CDE', 'Lower Box', 'GATE 2'),
  ('UB',  'Upper Box',         1500, 'FG',  'Upper Box', 'GATE 1'),
  ('GA',  'General Admission',  900, 'H',   'General',   'GATE 4')
) as t(code, label, price, rows, section, gate);
