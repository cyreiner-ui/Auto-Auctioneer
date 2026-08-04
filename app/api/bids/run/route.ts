import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireStaff } from "@/lib/staff-auth";
import { executeBid } from "@/lib/ebay-bidding";
import { validateBiddingConfig } from "@/lib/runtime-config";
import { isSchedulerRequest } from "@/lib/scheduler-auth";
import { listActiveBidLots } from "@/lib/bid-window";

export async function POST(request: Request) {
  if (!isSchedulerRequest(request.headers) && !(await requireStaff(request))) return NextResponse.json({ error: "Staff or scheduler access required." }, { status: 403 });
  if (process.env.EBAY_LIVE_BIDDING_ENABLED !== "true") return NextResponse.json({ enabled: false, message: "Live eBay bidding is disabled until Offer API approval and credentials are configured." }, { status: 503 });
  try { validateBiddingConfig(); } catch (error) { return NextResponse.json({ enabled: false, error: error instanceof Error ? error.message : "Bidding configuration is incomplete." }, { status: 503 }); }
  const now = new Date().toISOString();
  let data: unknown[];
  try { data = await listActiveBidLots(supabaseAdmin, now); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load active bids." }, { status: 500 }); }
  const results = [];
  for (const lot of data as Array<{ id: string; title: string; ebay_item_id: string; max_bid: number | string; currency: string; bid_window_start: string; bid_window_end: string; account_id: string; ebay_accounts?: { id: string; marketplace: string; refresh_token_ciphertext: string | null } | Array<{ id: string; marketplace: string; refresh_token_ciphertext: string | null }> }>) {
    const account = Array.isArray(lot.ebay_accounts) ? lot.ebay_accounts[0] : lot.ebay_accounts;
    if (!account) { results.push({ id: lot.id, status: "failed", error: "Selected eBay account was not found." }); continue; }
    results.push({ id: lot.id, ...(await executeBid(lot, account)) });
  }
  return NextResponse.json({ enabled: true, processed: results });
}

export async function GET(request: Request) {
  return POST(request);
}
