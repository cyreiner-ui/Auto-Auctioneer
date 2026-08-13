import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

const cleanPhrase = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);

function parseMaxCost(value: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, error: "Enter a valid per-knife price greater than 0." };
  return { ok: true, value: Math.round(parsed * 100) / 100 };
}

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phrase = cleanPhrase(body.phrase);
  if (!phrase) return NextResponse.json({ error: "Enter a keyword phrase." }, { status: 400 });
  const maxCost = parseMaxCost(body.max_cost_per_knife);
  if (!maxCost.ok) return NextResponse.json({ error: maxCost.error }, { status: 400 });
  const { data, error } = await supabaseAdmin.from("finder_keywords").insert({ phrase, max_cost_per_knife: maxCost.value }).select("*").single();
  if (error) return NextResponse.json({ error: error.code === "23505" ? "That keyword already exists." : error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "Keyword id is required." }, { status: 400 });
  const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.phrase !== undefined) {
    const phrase = cleanPhrase(body.phrase);
    if (!phrase) return NextResponse.json({ error: "Enter a keyword phrase." }, { status: 400 });
    changes.phrase = phrase;
  }
  if (body.enabled !== undefined) changes.enabled = Boolean(body.enabled);
  if (body.max_cost_per_knife !== undefined) {
    const maxCost = parseMaxCost(body.max_cost_per_knife);
    if (!maxCost.ok) return NextResponse.json({ error: maxCost.error }, { status: 400 });
    changes.max_cost_per_knife = maxCost.value;
  }
  const { data, error } = await supabaseAdmin.from("finder_keywords").update(changes).eq("id", body.id).select("*").single();
  if (error) return NextResponse.json({ error: error.code === "23505" ? "That keyword already exists." : error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Keyword id is required." }, { status: 400 });
  const { error } = await supabaseAdmin.from("finder_keywords").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
