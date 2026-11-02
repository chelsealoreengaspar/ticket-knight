-- Ticket Knight: wipe everything created by schema.sql so you can run it again.
-- WARNING: deletes all tickets, accounts rows and history. Auth users are kept.
drop table if exists
  public.sms_outbox, public.scan_events, public.activity_flags, public.ticket_history,
  public.ticket_transfers, public.ticket_holders, public.tickets, public.purchase_orders,
  public.seat_holds, public.otp_requests, public.event_tiers, public.gate_scanners,
  public.events, public.staff, public.accounts
cascade;

drop function if exists
  public.tk_hash(text), public.tk_norm_phone(text), public.tk_gov_id_hash(text),
  public.tk_validate_gov_id(text, text), public.tk_err(text, text, text),
  public.tk_is_staff(text[]), public.tk_owned(uuid, text), public.tk_age_on(date, date),
  public.tk_log(bigint, text, uuid, jsonb), public.tk_flag(uuid, text, bigint, text),
  public.tk_void_expired(), public.tk_ticket_reference(), public.tk_history_chain(),
  public.tk_history_digest(bigint, bigint, text, uuid, jsonb, timestamptz, text),
  public.request_otp(text), public.verify_otp(text, text),
  public.check_availability(text, text, text),
  public.complete_registration(text, text, date, text, text, uuid),
  public.get_seat_map(text), public.hold_seats(text, text, text[]), public.release_holds(text),
  public.finalize_order(text, jsonb), public.request_transfer(bigint, text),
  public.respond_transfer(bigint, boolean), public.cancel_transfer(bigint),
  public.admin_revoke_ticket(bigint, text), public.admin_resolve_flag(bigint),
  public.admin_verify_history(), public.get_scanner_bundle(),
  public.tk_queue_sms(bigint, text, text, timestamptz), public.sync_scans(jsonb)
cascade;
