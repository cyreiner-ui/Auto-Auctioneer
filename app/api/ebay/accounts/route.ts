import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { staffOnly } from "@/app/api/bids/auth";

export async function GET(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const { data, error } = await supabaseAdmin.from("ebay_accounts").select("id, label, ebay_username, marketplace, status, created_at").order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

export async function POST(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  if (!String(body.label || "").trim()) return NextResponse.json({ error: "Account label is required." }, { status: 400 });
  const { data, error } = await supabaseAdmin.from("ebay_accounts").insert({ label: String(body.label).trim(), marketplace: String(body.marketplace || "EBAY_US"), status: "disconnected" }).select("id, label, marketplace, status, created_at").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
