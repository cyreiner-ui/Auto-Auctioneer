import { NextResponse } from "next/server";
import { IMAGE_BUCKET, supabaseAdmin } from "@/lib/supabase-admin";

export async function GET() {
  const [{ count: listingCount }, { count: imageCount }, root] = await Promise.all([
    supabaseAdmin.from("app_listings").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("app_listing_images").select("id", { count: "exact", head: true }),
    supabaseAdmin.storage.from(IMAGE_BUCKET).list("", { limit: 1000 }),
  ]);
  if (root.error) return NextResponse.json({ error: root.error.message }, { status: 500 });
  const folders = (root.data || []).filter((entry) => !entry.metadata).map((entry) => entry.name);
  const nested = await Promise.all(folders.map((folder) => supabaseAdmin.storage.from(IMAGE_BUCKET).list(folder, { limit: 1000 })));
  const files = nested.flatMap((result) => result.data || []);
  if (nested.some((result) => result.error)) return NextResponse.json({ error: "Could not read image storage." }, { status: 500 });
  return NextResponse.json({ listings: listingCount || 0, images: imageCount || 0, files: files.length, bytes: files.reduce((sum, file) => sum + Number(file.metadata?.size || 0), 0) });
}

export async function POST() {
  const [{ data: refs }, root] = await Promise.all([
    supabaseAdmin.from("app_listing_images").select("storage_path").not("storage_path", "is", null),
    supabaseAdmin.storage.from(IMAGE_BUCKET).list("", { limit: 1000 }),
  ]);
  if (root.error) return NextResponse.json({ error: root.error.message }, { status: 500 });
  const folders = (root.data || []).filter((entry) => !entry.metadata).map((entry) => entry.name);
  const nested = await Promise.all(folders.map((folder) => supabaseAdmin.storage.from(IMAGE_BUCKET).list(folder, { limit: 1000 })));
  if (nested.some((result) => result.error)) return NextResponse.json({ error: "Could not read image storage." }, { status: 500 });
  const used = new Set((refs || []).map((row) => row.storage_path));
  const allFiles = nested.flatMap((result, index) => (result.data || []).map((file) => ({ ...file, path: `${folders[index]}/${file.name}` })));
  const orphaned = allFiles.filter((file) => !used.has(file.path));
  if (orphaned.length) await supabaseAdmin.storage.from(IMAGE_BUCKET).remove(orphaned.map((file) => file.path));
  return NextResponse.json({ deleted: orphaned.length, bytesFreed: orphaned.reduce((sum, file) => sum + Number(file.metadata?.size || 0), 0) });
}
