import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireStaff } from "@/lib/staff-auth";
import { executeBid } from "@/lib/ebay-bidding";
import { validateBiddingConfig } from "@/lib/runtime-config";

export async function POST(request: Request) {
  const schedulerSecret = process.env.BID_SCHEDULER_SECRET || process.env.CRON_SECRET;
  const schedulerAuthorized = Boolean(schedulerSecret && (request.headers.get("x-bid-scheduler-secret") === schedulerSecret || request.headers.get("authorization") === `Bearer ${schedulerSecret}`));
  if (!schedulerAuthorized && !(await requireStaff(request))) return NextResponse.json({ error: "Staff or scheduler access required." }, { status: 403 });
  if (process.env.EBAY_LIVE_BIDDING_ENABLED !== "true") return NextResponse.json({ enabled: false, message: "Live eBay bidding is disabled until Offer API approval and credentials are configured." }, { status: 503 });
  try { validateBiddingConfig(); } catch (error) { return NextResponse.json({ enabled: false, error: error instanceof Error ? error.message : "Bidding configuration is incomplete." }, { status: 503 }); }
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from("bid_lots").select("id, title, ebay_item_id, max_bid, currency, bid_window_start, bid_window_end, account_id, ebay_accounts(id, marketplace, refresh_token_ciphertext)").eq("status", "armed").lte("bid_window_start", now).gte("bid_window_end", now).limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const results = [];
  for (const lot of data || []) {
    const account = Array.isArray(lot.ebay_accounts) ? lot.ebay_accounts[0] : lot.ebay_accounts;
    if (!account) { results.push({ id: lot.id, status: "failed", error: "Selected eBay account was not found." }); continue; }
    results.push({ id: lot.id, ...(await executeBid(lot, account)) });
  }
  return NextResponse.json({ enabled: true, processed: results });
}

export async function GET(request: Request) {
  return POST(request);
}
