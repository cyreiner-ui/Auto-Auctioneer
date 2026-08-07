import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const ebayItemId = String(body.ebayItemId || "");
  if (!ebayItemId) return NextResponse.json({ error: "ebayItemId is required." }, { status: 400 });
  const { error } = await supabaseAdmin.from("finder_items").update({ dismissed_at: body.dismissed ? new Date().toISOString() : null }).eq("ebay_item_id", ebayItemId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Item id is required." }, { status: 400 });
  const { error } = await supabaseAdmin.from("finder_items").delete().eq("ebay_item_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
