import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

const MODES = new Set(["auctions_only", "all_qualified"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmail = (value: unknown) => String(value || "").trim().toLowerCase().slice(0, 254);

export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  if (!MODES.has(body.mode)) return NextResponse.json({ error: "Choose a valid notification mode." }, { status: 400 });
  const { data, error } = await supabaseAdmin
    .from("finder_notify_settings")
    .upsert({ id: true, notify_mode: body.mode, updated_at: new Date().toISOString() }, { onConflict: "id" })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const email = cleanEmail(body.email);
  if (!email || !EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid recipient email address." }, { status: 400 });
  const { data, error } = await supabaseAdmin.from("finder_notify_recipients").insert({ email }).select("*").single();
  if (error) return NextResponse.json({ error: error.code === "23505" ? "That email is already a recipient." : error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Recipient id is required." }, { status: 400 });
  const { error } = await supabaseAdmin.from("finder_notify_recipients").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
