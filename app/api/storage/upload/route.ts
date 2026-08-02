import { NextResponse } from "next/server";
import { IMAGE_BUCKET, supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  const listingId = String(form.get("listingId") || "unknown");
  if (!(file instanceof File)) return NextResponse.json({ error: "No image supplied" }, { status: 400 });
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = `${listingId}/${crypto.randomUUID()}-${safeName}`;
  const upload = await supabaseAdmin.storage.from(IMAGE_BUCKET).upload(path, await file.arrayBuffer(), { contentType: file.type || "image/jpeg", upsert: false });
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 500 });
  const signed = await supabaseAdmin.storage.from(IMAGE_BUCKET).createSignedUrl(path, 60 * 60);
  return NextResponse.json({ storagePath: path, src: signed.data?.signedUrl || "", name: file.name });
}

export async function DELETE(request: Request) {
  const { storagePath } = await request.json().catch(() => ({ storagePath: "" }));
  if (!storagePath) return NextResponse.json({ ok: false }, { status: 400 });
  const result = await supabaseAdmin.storage.from(IMAGE_BUCKET).remove([storagePath]);
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
