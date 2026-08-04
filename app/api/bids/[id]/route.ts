import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { staffOnly } from "../auth";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const { data: current, error: currentError } = await supabaseAdmin.from("bid_lots").select("status, account_id").eq("id", id).single();
  if (currentError || !current) return NextResponse.json({ error: "Bid lot not found." }, { status: 404 });
  if (["submitted", "won", "lost"].includes(current.status)) return NextResponse.json({ error: "Submitted bids cannot be edited." }, { status: 409 });
  if (body.action === "arm") {
    const { data: account } = await supabaseAdmin.from("ebay_accounts").select("status").eq("id", current.account_id).single();
    if (account?.status !== "connected") return NextResponse.json({ error: "Connect the selected eBay account before arming this bid." }, { status: 409 });
  }
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ account_id: body.accountId, max_bid: body.maxBid, currency: body.currency, all_in_budget: body.allInBudget || null, auction_end_at: body.auctionEndAt || null, bid_window_start: body.bidWindowStart, bid_window_end: body.bidWindowEnd, title: body.title, ebay_url: body.ebayUrl })) if (value !== undefined) changes[key] = value;
  if (body.action === "arm") { changes.status = "armed"; changes.armed_at = new Date().toISOString(); }
  if (body.action === "disarm") { changes.status = "draft"; changes.armed_at = null; }
  const { data, error } = await supabaseAdmin.from("bid_lots").update(changes).eq("id", id).select("*, ebay_accounts(id, label, marketplace, status)").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
