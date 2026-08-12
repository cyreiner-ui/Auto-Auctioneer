import { NextResponse } from "next/server";
import { addSnipe } from "@/lib/gixen-client";
import { requireStaff } from "@/lib/staff-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const ebayItemId = String(body.ebayItemId || "");
  if (!ebayItemId) return NextResponse.json({ error: "An item id is required." }, { status: 400 });
  const { data: row, error: loadError } = await supabaseAdmin.from("finder_items").select("ebay_item_id, item_price, shipping_cost, total_cost").eq("ebay_item_id", ebayItemId).maybeSingle();
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Item not found." }, { status: 404 });
  const totalCost = row.total_cost != null ? Number(row.total_cost) : Number(row.item_price) + Number(row.shipping_cost || 0);
  const result = await addSnipe({ itemId: row.ebay_item_id, maxBid: totalCost });
  const { error: saveError } = await supabaseAdmin.from("finder_items").update({
    gixen_status: result.ok ? "sent" : "failed",
    gixen_message: result.message,
    gixen_sent_at: result.ok ? new Date().toISOString() : null,
  }).eq("ebay_item_id", ebayItemId);
  if (saveError) return NextResponse.json({ error: saveError.message }, { status: 500 });
  return NextResponse.json({ ok: result.ok, message: result.message });
}
