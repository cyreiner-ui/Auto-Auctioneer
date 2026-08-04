import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { listBidData } from "@/lib/bids";
import { staffOnly } from "./auth";

export async function GET(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  try { return NextResponse.json(await listBidData()); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load bids." }, { status: 500 }); }
}

export async function POST(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const maxBid = Number(body.maxBid);
  if (!body.ebayItemId || !body.ebayUrl || !body.accountId || !Number.isFinite(maxBid) || maxBid <= 0 || !body.bidWindowStart || !body.bidWindowEnd) return NextResponse.json({ error: "Item, account, max bid, and bid window are required." }, { status: 400 });
  if (new Date(body.bidWindowEnd).getTime() <= new Date(body.bidWindowStart).getTime()) return NextResponse.json({ error: "Bid window end must be after its start." }, { status: 400 });
  const { data, error } = await supabaseAdmin.from("bid_lots").insert({ ebay_item_id: String(body.ebayItemId), ebay_url: String(body.ebayUrl), title: String(body.title || "Untitled eBay lot"), account_id: String(body.accountId), max_bid: maxBid, currency: String(body.currency || "USD"), all_in_budget: body.allInBudget ? Number(body.allInBudget) : null, auction_end_at: body.auctionEndAt || null, bid_window_start: body.bidWindowStart, bid_window_end: body.bidWindowEnd, timezone: "America/New_York", status: "draft" }).select("*, ebay_accounts(id, label, marketplace, status)").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
