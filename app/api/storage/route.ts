import { NextResponse } from "next/server";
import { IMAGE_BUCKET, supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  const [{ count: listingCount }, { count: imageCount }, objects] = await Promise.all([
    supabaseAdmin.from("app_listings").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("app_listing_images").select("id", { count: "exact", head: true }),
    supabaseAdmin.schema("storage").from("objects").select("name,size").eq("bucket_id", IMAGE_BUCKET),
  ]);
  if (objects.error) return NextResponse.json({ error: objects.error.message }, { status: 500 });
  const files = objects.data || [];
  return NextResponse.json({ listings: listingCount || 0, images: imageCount || 0, files: files.length, bytes: files.reduce((sum, file) => sum + Number(file.size || 0), 0) });
}

export async function POST() {
  const [{ data: refs }, objects] = await Promise.all([
    supabaseAdmin.from("app_listing_images").select("storage_path").not("storage_path", "is", null),
    supabaseAdmin.schema("storage").from("objects").select("name,size").eq("bucket_id", IMAGE_BUCKET),
  ]);
  if (objects.error) return NextResponse.json({ error: objects.error.message }, { status: 500 });
  const used = new Set((refs || []).map((row) => row.storage_path));
  const orphaned = (objects.data || []).filter((file) => !used.has(file.name));
  if (orphaned.length) await supabaseAdmin.storage.from(IMAGE_BUCKET).remove(orphaned.map((file) => file.name));
  return NextResponse.json({ deleted: orphaned.length, bytesFreed: orphaned.reduce((sum, file) => sum + Number(file.size || 0), 0) });
}
