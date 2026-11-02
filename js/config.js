// Ticket Knight configuration.
// These three values are SAFE to commit: the publishable/anon key only works
// within the Row Level Security rules, and the public key can only VERIFY tickets.
// NEVER put the secret signing key or the service_role / sb_secret_ key here.
window.TK_CONFIG = {
  // Supabase > Project Settings > API (or "Connect" button) > Project URL
  SUPABASE_URL: "https://qkbijjjgdcqmanzkztik.supabase.co",

  // Supabase > Project Settings > API Keys > Publishable key (sb_publishable_...)
  // or the legacy "anon public" key. Either works.
  SUPABASE_ANON_KEY: "sb_publishable_UnfBEs0dyIVyuHxD3NdhMw_CRLkPYOq",

  // PUBLIC key printed by tools/keygen.html (used by the offline gate scanner)
  TK_PUBLIC_KEY: "BEkrSqR60kKMjwGkw7Yg0UMTkVqaw151QPSpWuDy3SQ",

  SUPPORT_CONTACT: "support@ticketknight.test"
};
