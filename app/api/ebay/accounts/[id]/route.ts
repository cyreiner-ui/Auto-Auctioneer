import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { staffOnly } from "@/app/api/bids/auth";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await staffOnly(request);
  if (denied) return denied;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "Account id is required." }, { status: 400 });

  const { count, error: bidsError } = await supabaseAdmin
    .from("bid_lots")
    .select("id", { count: "exact", head: true })
    .eq("account_id", id);
  if (bidsError) return NextResponse.json({ error: bidsError.message }, { status: 500 });
  if ((count || 0) > 0) {
    return NextResponse.json(
      { error: "This eBay account is still assigned to bid lots. Disarm or remove those lots first." },
      { status: 409 },
    );
  }

  const { error } = await supabaseAdmin.from("ebay_accounts").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
