import { supabaseAdmin } from "./supabase-admin";
import { dayKey } from "./finder-core";

function isSupabaseConfigured() {
  return Boolean((process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Tracks every request this app sends to eBay's own API hosts (OAuth token exchange, Browse API
// search/item lookups, Buy/Offer bidding) so staff can see usage against eBay's daily rate limit
// from the finder dashboard. Best-effort and fire-and-forget from the caller's perspective: a
// failure here must never break the eBay call it's counting, and it no-ops entirely when
// Supabase isn't configured (local/test runs) rather than attempting a doomed request against
// lib/supabase-admin.ts's placeholder fallback client.
export async function recordEbayApiCall() {
  if (!isSupabaseConfigured()) return;
  try {
    await supabaseAdmin.rpc("increment_ebay_api_calls", { p_day: dayKey() });
  } catch (error) {
    console.error("Failed to record eBay API call usage.", error);
  }
}

export async function getEbayApiCallsToday() {
  const { data, error } = await supabaseAdmin.from("ebay_api_calls_daily").select("calls").eq("day", dayKey()).maybeSingle();
  if (error) throw new Error(error.message);
  return Number(data?.calls || 0);
}
