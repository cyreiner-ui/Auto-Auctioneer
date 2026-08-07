import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const ebayItemIds = Array.isArray(body.ebayItemIds) ? body.ebayItemIds.map(String).filter(Boolean) : [];
  if (!ebayItemIds.length) return NextResponse.json({ error: "At least one item id is required." }, { status: 400 });
  const { error } = await supabaseAdmin.from("finder_items").update({ dismissed_at: body.dismissed ? new Date().toISOString() : null }).in("ebay_item_id", ebayItemIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return NextResponse.json({ error: "At least one item id is required." }, { status: 400 });
  const { error } = await supabaseAdmin.from("finder_items").delete().in("ebay_item_id", ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
