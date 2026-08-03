import { NextResponse } from "next/server";
import { IMAGE_BUCKET, supabaseAdmin } from "@/lib/supabase-admin";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const listing = await request.json();
  const response = await fetch(new URL("/api/listings", request.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...listing, id }) });
  return NextResponse.json(await response.json(), { status: response.status });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const { data: images } = await supabaseAdmin.from("app_listing_images").select("storage_path").eq("listing_id", id).not("storage_path", "is", null);
  const paths = (images || []).map((image) => image.storage_path).filter(Boolean);
  if (paths.length) await supabaseAdmin.storage.from(IMAGE_BUCKET).remove(paths);
  const { error } = await supabaseAdmin.from("app_listings").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
