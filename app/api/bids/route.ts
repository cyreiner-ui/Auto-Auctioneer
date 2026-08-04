import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { listBidData } from "@/lib/bids";
import { validateBidInput } from "@/lib/bid-validation";
import { staffOnly } from "./auth";

export async function GET(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  try { return NextResponse.json(await listBidData()); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load bids." }, { status: 500 }); }
}

export async function POST(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const parsedBody = await request.json().catch(() => ({}));
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? parsedBody as Record<string, unknown> : {};
  const validation = validateBidInput(body);
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
  const bid = validation.value;
  const { data, error } = await supabaseAdmin.from("bid_lots").insert({ ebay_item_id: bid.ebayItemId, ebay_url: bid.ebayUrl, title: bid.title, account_id: bid.accountId, max_bid: bid.maxBid, currency: bid.currency, all_in_budget: bid.allInBudget, auction_end_at: bid.auctionEndAt, bid_window_start: bid.bidWindowStart, bid_window_end: bid.bidWindowEnd, timezone: "America/New_York", status: "draft" }).select("*, ebay_accounts(id, label, marketplace, status)").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
