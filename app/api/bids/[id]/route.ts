import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { staffOnly } from "../auth";
import { validateBidInput } from "@/lib/bid-validation";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const { id } = await context.params;
  const parsedBody = await request.json().catch(() => ({}));
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? parsedBody as Record<string, unknown> : {};
  const action = body.action;
  if (action !== undefined && action !== "arm" && action !== "disarm" && action !== "mark_manual_submitted") return NextResponse.json({ error: "Unsupported bid action." }, { status: 400 });
  const { data: current, error: currentError } = await supabaseAdmin.from("bid_lots").select("id, status, execution_mode, account_id, ebay_item_id, ebay_url, title, max_bid, currency, all_in_budget, auction_end_at, bid_window_start, bid_window_end").eq("id", id).single();
  if (currentError || !current) return NextResponse.json({ error: "Bid lot not found." }, { status: 404 });
  if (action === "mark_manual_submitted") {
    if (current.execution_mode !== "manual") return NextResponse.json({ error: "Only manual lots can be marked submitted." }, { status: 409 });
    if (!["armed", "draft", "failed"].includes(current.status)) return NextResponse.json({ error: "This lot is already submitted or closed." }, { status: 409 });
    const { data, error } = await supabaseAdmin.from("bid_lots").update({ status: "submitted", submitted_at: new Date().toISOString() }).eq("id", id).select("*, ebay_accounts(id, label, marketplace, status)").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await supabaseAdmin.from("bid_notifications").update({ acknowledged_at: new Date().toISOString() }).eq("bid_lot_id", id).eq("kind", "manual_bid_due");
    return NextResponse.json(data);
  }
  if (["queued", "submitted", "outbid", "won", "lost", "cancelled"].includes(current.status)) return NextResponse.json({ error: "Submitted bids cannot be edited." }, { status: 409 });
  if (action === "arm" && !["draft", "failed"].includes(current.status)) return NextResponse.json({ error: "Only draft or failed bids can be armed." }, { status: 409 });
  if (action === "disarm" && current.status !== "armed") return NextResponse.json({ error: "Only armed bids can be disarmed." }, { status: 409 });
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const mergedInput = {
    ebayItemId: has("ebayItemId") ? body.ebayItemId : current.ebay_item_id,
    ebayUrl: has("ebayUrl") ? body.ebayUrl : current.ebay_url,
    title: has("title") ? body.title : current.title,
    accountId: has("accountId") ? body.accountId : current.account_id,
    executionMode: has("executionMode") ? body.executionMode : current.execution_mode,
    maxBid: has("maxBid") ? body.maxBid : current.max_bid,
    currency: has("currency") ? body.currency : current.currency,
    allInBudget: has("allInBudget") ? body.allInBudget : current.all_in_budget,
    auctionEndAt: has("auctionEndAt") ? body.auctionEndAt : current.auction_end_at,
    bidWindowStart: has("bidWindowStart") ? body.bidWindowStart : current.bid_window_start,
    bidWindowEnd: has("bidWindowEnd") ? body.bidWindowEnd : current.bid_window_end,
  };
  const validation = validateBidInput(mergedInput);
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
  if (action === "arm" && validation.value.executionMode === "automatic") {
    const { data: account } = await supabaseAdmin.from("ebay_accounts").select("status").eq("id", validation.value.accountId).single();
    if (account?.status !== "connected") return NextResponse.json({ error: "Connect the selected eBay account before arming this bid." }, { status: 409 });
  }
  const changes: Record<string, unknown> = {};
  const fieldMap: Record<string, [string, unknown]> = {
    accountId: ["account_id", validation.value.accountId], executionMode: ["execution_mode", validation.value.executionMode], maxBid: ["max_bid", validation.value.maxBid], currency: ["currency", validation.value.currency], allInBudget: ["all_in_budget", validation.value.allInBudget], auctionEndAt: ["auction_end_at", validation.value.auctionEndAt], bidWindowStart: ["bid_window_start", validation.value.bidWindowStart], bidWindowEnd: ["bid_window_end", validation.value.bidWindowEnd], title: ["title", validation.value.title], ebayUrl: ["ebay_url", validation.value.ebayUrl]
  };
  for (const key of Object.keys(fieldMap)) if (has(key)) { const [column, value] = fieldMap[key]; changes[column] = value; }
  if (action === "arm") { changes.status = "armed"; changes.armed_at = new Date().toISOString(); }
  if (action === "disarm") { changes.status = "draft"; changes.armed_at = null; }
  if (!Object.keys(changes).length) return NextResponse.json({ error: "At least one bid field or action is required." }, { status: 400 });
  const { data, error } = await supabaseAdmin.from("bid_lots").update(changes).eq("id", id).select("*, ebay_accounts(id, label, marketplace, status)").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
