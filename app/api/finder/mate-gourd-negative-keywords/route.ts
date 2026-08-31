import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

// A staff-editable, post-fetch text filter applied to every maté-gourd candidate before any Gemini
// call (see lib/mate-gourd-finder.ts's matchesNegativeKeyword). Mirrors
// app/api/finder/gaucho-negative-keywords/route.ts, but against its own table
// (finder_mate_gourd_negative_keywords) — a maté-gourd lookalike filter has nothing to do with the
// gaucho-knife or pocket-knife pipelines' own junk terms.
const cleanPhrase = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 200);

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phrase = cleanPhrase(body.phrase);
  if (!phrase) return NextResponse.json({ error: "Enter a negative keyword phrase." }, { status: 400 });
  const { data, error } = await supabaseAdmin.from("finder_mate_gourd_negative_keywords").insert({ phrase }).select("*").single();
  if (error) return NextResponse.json({ error: error.code === "23505" ? "That negative keyword already exists." : error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "Negative keyword id is required." }, { status: 400 });
  const changes: Record<string, unknown> = {};
  if (body.phrase !== undefined) {
    const phrase = cleanPhrase(body.phrase);
    if (!phrase) return NextResponse.json({ error: "Enter a negative keyword phrase." }, { status: 400 });
    changes.phrase = phrase;
  }
  if (body.enabled !== undefined) changes.enabled = Boolean(body.enabled);
  const { data, error } = await supabaseAdmin.from("finder_mate_gourd_negative_keywords").update(changes).eq("id", body.id).select("*").single();
  if (error) return NextResponse.json({ error: error.code === "23505" ? "That negative keyword already exists." : error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Negative keyword id is required." }, { status: 400 });
  const { error } = await supabaseAdmin.from("finder_mate_gourd_negative_keywords").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
