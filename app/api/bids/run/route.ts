import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireStaff } from "@/lib/staff-auth";
import { executeBid } from "@/lib/ebay-bidding";
import { validateBiddingConfig } from "@/lib/runtime-config";
import { isSchedulerRequest } from "@/lib/scheduler-auth";
import { listActiveBidLots } from "@/lib/bid-window";
import { createManualBidReminders } from "@/lib/bid-reminders";

export async function POST(request: Request) {
  if (!isSchedulerRequest(request.headers) && !(await requireStaff(request))) return NextResponse.json({ error: "Staff or scheduler access required." }, { status: 403 });
  const now = new Date().toISOString();
  let data: unknown[];
  try { data = await listActiveBidLots(supabaseAdmin, now); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load active bids." }, { status: 500 }); }
  const lots = data as Array<{ id: string; title: string; ebay_url: string; ebay_item_id: string; max_bid: number | string; currency: string; bid_window_start: string; bid_window_end: string; account_id: string | null; execution_mode?: "manual" | "automatic"; ebay_accounts?: { id: string; marketplace: string; refresh_token_ciphertext: string | null } | Array<{ id: string; marketplace: string; refresh_token_ciphertext: string | null }> }>;
  const manualLots = lots.filter((lot) => (lot.execution_mode || "manual") === "manual");
  const reminders = await createManualBidReminders(manualLots);
  const automaticLots = lots.filter((lot) => (lot.execution_mode || "manual") === "automatic");
  const results = [];
  if (automaticLots.length && process.env.EBAY_LIVE_BIDDING_ENABLED === "true") {
    try { validateBiddingConfig(); } catch (error) { return NextResponse.json({ enabled: false, reminders, error: error instanceof Error ? error.message : "Bidding configuration is incomplete." }, { status: 503 }); }
  }
  for (const lot of automaticLots) {
    if (process.env.EBAY_LIVE_BIDDING_ENABLED !== "true") { results.push({ id: lot.id, status: "skipped", reason: "automatic_bidding_disabled" }); continue; }
    const account = Array.isArray(lot.ebay_accounts) ? lot.ebay_accounts[0] : lot.ebay_accounts;
    if (!account) { results.push({ id: lot.id, status: "failed", error: "Selected eBay account was not found." }); continue; }
    results.push({ id: lot.id, ...(await executeBid(lot, account)) });
  }
  return NextResponse.json({ enabled: process.env.EBAY_LIVE_BIDDING_ENABLED === "true", reminders, processed: results, manual: manualLots.map((lot) => lot.id) });
}

export async function GET(request: Request) {
  return POST(request);
}
