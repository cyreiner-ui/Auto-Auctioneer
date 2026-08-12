import { NextResponse } from "next/server";
import { addSnipe, isAuctionFormat } from "@/lib/gixen-client";
import { requireStaff } from "@/lib/staff-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

// addSnipe drives a headless browser (see lib/gixen-client.ts), which needs
// the Node runtime and more time than the platform default.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const ebayItemId = String(body.ebayItemId || "");
  if (!ebayItemId) return NextResponse.json({ error: "An item id is required." }, { status: 400 });
  const { data: row, error: loadError } = await supabaseAdmin.from("finder_items").select("ebay_item_id, buying_options").eq("ebay_item_id", ebayItemId).maybeSingle();
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Item not found." }, { status: 404 });
  if (!isAuctionFormat(row.buying_options)) {
    const message = "Gixen only snipes eBay auctions; this is a fixed-price listing.";
    const { error: saveError } = await supabaseAdmin.from("finder_items").update({ gixen_status: "not_auction", gixen_message: message, gixen_sent_at: null }).eq("ebay_item_id", ebayItemId);
    if (saveError) return NextResponse.json({ error: saveError.message }, { status: 500 });
    return NextResponse.json({ ok: false, message });
  }

  const maxBid = Math.round(Number(body.maxBid) * 100) / 100;
  if (!Number.isFinite(maxBid) || maxBid <= 0) {
    return NextResponse.json({ error: "Enter a valid max bid greater than $0 before sending to Gixen." }, { status: 400 });
  }

  // Persist the entered bid before attempting the send, so a Gixen failure
  // never loses what the user typed.
  const { error: bidSaveError } = await supabaseAdmin.from("finder_items").update({ max_bid: maxBid }).eq("ebay_item_id", ebayItemId);
  if (bidSaveError) return NextResponse.json({ error: bidSaveError.message }, { status: 500 });

  const result = await addSnipe({ itemId: row.ebay_item_id, maxBid });
  const { error: saveError } = await supabaseAdmin.from("finder_items").update({
    gixen_status: result.ok ? "sent" : "failed",
    gixen_message: result.message,
    gixen_sent_at: result.ok ? new Date().toISOString() : null,
  }).eq("ebay_item_id", ebayItemId);
  if (saveError) return NextResponse.json({ error: saveError.message }, { status: 500 });
  return NextResponse.json({ ok: result.ok, message: result.message });
}
