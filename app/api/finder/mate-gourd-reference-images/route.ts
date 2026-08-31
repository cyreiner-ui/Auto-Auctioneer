import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

const BUCKET = "finder-reference-images";

// Staff-uploaded reference photos of the one specific maté gourd being sought, driving both the
// searchByImage discovery calls and the Gemini vision comparison prompt (see
// lib/mate-gourd-finder.ts). Mirrors app/api/finder/gaucho-reference-images/route.ts exactly,
// against the same shared private bucket — finder_reference_images.category is what keeps the two
// categories' rows apart, not a separate bucket.
export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const form = await request.formData();
  const file = form.get("file");
  const label = String(form.get("label") || "").trim().slice(0, 120) || null;
  if (!(file instanceof File)) return NextResponse.json({ error: "No image supplied." }, { status: 400 });
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = `${crypto.randomUUID()}-${safeName}`;
  const upload = await supabaseAdmin.storage.from(BUCKET).upload(path, await file.arrayBuffer(), { contentType: file.type || "image/jpeg", upsert: false });
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 500 });
  const { data, error } = await supabaseAdmin.from("finder_reference_images").insert({ category: "mate_gourd", storage_path: path, label }).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const signed = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  return NextResponse.json({ ...data, signedUrl: signed.data?.signedUrl || null });
}

export async function DELETE(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Reference image id is required." }, { status: 400 });
  const { data: row, error: fetchError } = await supabaseAdmin.from("finder_reference_images").select("storage_path").eq("id", id).maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Reference image not found." }, { status: 404 });
  const { error: deleteError } = await supabaseAdmin.from("finder_reference_images").delete().eq("id", id);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });
  await supabaseAdmin.storage.from(BUCKET).remove([row.storage_path]);
  return NextResponse.json({ ok: true });
}
