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

// Soft-cap default for eBay's own ~5,000-calls/day Browse API budget shared across every eBay
// call this app makes (search, shipping/description lookups, image search — see
// EBAY_REQUEST_TIMEOUT_MS's comment in lib/ebay-finder.ts). Kept a safety margin under the real
// limit so a run or tick that would tip the day's count over 5,000 defers gracefully instead of
// finding out the hard way — which is exactly what the 2026-08-24/25/27 gaucho-knife backlog did,
// repeatedly, until a manual pocket-knife run's every single keyword search came back 429.
// Overridable via EBAY_DAILY_CALL_LIMIT, the same shape as GEMINI_DAILY_ANALYSIS_LIMIT.
const DEFAULT_EBAY_DAILY_CALL_LIMIT = 4500;

function ebayDailyCallLimit() {
  return Number(process.env.EBAY_DAILY_CALL_LIMIT || DEFAULT_EBAY_DAILY_CALL_LIMIT);
}

// Checked once, up front — by startFinderRun before spending a single keyword search, and by
// processPendingFinderItems before pulling a batch of pending items — rather than per individual
// eBay call, so a day already at/over the soft cap defers the whole scan/batch at once instead of
// burning through the rest of its budget one 429 at a time. Mirrors isSupabaseConfigured's
// no-op-when-unconfigured behavior in recordEbayApiCall above: never blocks work in local/test
// runs where there's no real budget being tracked.
export async function ebayBudgetExceeded() {
  if (!isSupabaseConfigured()) return false;
  const callsToday = await getEbayApiCallsToday();
  return callsToday >= ebayDailyCallLimit();
}
