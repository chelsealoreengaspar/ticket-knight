// Ticket Knight - sign-tickets Edge Function (FR-002c, NFR-003)
//
// Signs every PENDING ticket owned by the caller with the PRIVATE Ed25519
// key, then marks it ACTIVE. The key lives only here (secret TK_SIGNING_KEY);
// gate scanners hold only the public key, so they can verify offline but
// can never create a valid ticket.
//
// Deploy: Supabase Dashboard > Edge Functions > Deploy a new function > Via Editor,
// name it exactly "sign-tickets", paste this file, Deploy.
// Secrets needed: TK_SIGNING_KEY (from tools/keygen.html).

import { createClient } from "npm:@supabase/supabase-js@2";
import nacl from "npm:tweetnacl@1.0.3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.trim().replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Service key: legacy SUPABASE_SERVICE_ROLE_KEY, or the new sb_secret_ key.
function serviceKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const json = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (json) {
    try { return JSON.parse(json)["default"]; } catch { /* ignore */ }
  }
  return Deno.env.get("TK_SERVICE_KEY");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = serviceKey();
  const signingKey = Deno.env.get("TK_SIGNING_KEY");
  if (!url || !key) return reply({ error: "Server is missing its Supabase service key." }, 500);
  if (!signingKey) return reply({ error: "Server is missing the TK_SIGNING_KEY secret." }, 500);

  let secret: Uint8Array;
  try {
    secret = fromB64url(signingKey);
    if (secret.length !== 64) throw new Error("bad length");
  } catch {
    return reply({ error: "TK_SIGNING_KEY is not a valid 64-byte key. Copy it again from tools/keygen.html." }, 500);
  }

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Who is calling? (the browser sends the signed-in user's access token)
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return reply({ error: "Please sign in again." }, 401);
  const uid = userData.user.id;

  const { data: rows, error } = await admin
    .from("tickets")
    .select("id, reference, event_id, tier, section, seat, assigned_gate, barcode_serial, owner_account_id, ticket_holders(holder_name)")
    .eq("owner_account_id", uid)
    .eq("status", "PENDING");
  if (error) return reply({ error: error.message }, 500);

  const enc = new TextEncoder();
  let signed = 0;
  for (const t of rows ?? []) {
    const h = Array.isArray(t.ticket_holders) ? t.ticket_holders[0] : t.ticket_holders;
    // Field order is fixed so the signed string is always identical.
    const payload = JSON.stringify({
      v: 1,
      tid: t.id,
      ref: t.reference,
      ser: t.barcode_serial,
      ev: t.event_id,
      tier: t.tier,
      sec: t.section,
      seat: t.seat,
      gate: t.assigned_gate,
      name: h?.holder_name ?? "",
      acc: t.owner_account_id,
      iat: Math.floor(Date.now() / 1000),
    });
    const sig = nacl.sign.detached(enc.encode(payload), secret);
    const { error: upErr } = await admin
      .from("tickets")
      .update({ payload, signature: toB64url(sig), status: "ACTIVE" })
      .eq("id", t.id)
      .eq("status", "PENDING");
    if (upErr) return reply({ error: upErr.message, signed }, 500);
    await admin.from("ticket_history").insert({
      ticket_id: t.id, action_type: "SIGNED", actor: uid, details: { serial: t.barcode_serial },
    });
    signed++;
  }
  return reply({ ok: true, signed });
});
