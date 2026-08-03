import { NextResponse } from "next/server";
import { IMAGE_BUCKET, supabaseAdmin } from "@/lib/supabase-admin";

async function withImageUrls(rows: any[]) {
  return Promise.all(rows.map(async (row) => {
    const images = await Promise.all((row.app_listing_images || []).sort((a: any, b: any) => a.display_order - b.display_order).map(async (image: any) => {
      let src = image.source_url || "";
      if (image.storage_path) {
        const signed = await supabaseAdmin.storage.from(IMAGE_BUCKET).createSignedUrl(image.storage_path, 60 * 60);
        src = signed.data?.signedUrl || src;
      }
      return { id: image.id, src, name: image.name, storagePath: image.storage_path || undefined };
    }));
    return { id: row.id, ebayUrl: row.ebay_url, title: row.title, auctioneerNotes: row.auctioneer_notes || "", description: row.description, price: Number(row.price || 0), status: row.status, finalPrice: row.final_price == null ? undefined : Number(row.final_price), buyer: row.buyer || undefined, completedAt: row.completed_at || undefined, images };
  }));
}

export async function GET() {
  const { data, error } = await supabaseAdmin.from("app_listings").select("*, app_listing_images(*)").order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(await withImageUrls(data || []));
}

export async function POST(request: Request) {
  const listing = await request.json();
  const { error } = await supabaseAdmin.from("app_listings").upsert({ id: listing.id, ebay_item_id: listing.id, ebay_url: listing.ebayUrl, title: listing.title || "", auctioneer_notes: listing.auctioneerNotes || "", description: listing.description || "", price: listing.price || 0, status: listing.status || "draft", final_price: listing.finalPrice ?? null, buyer: listing.buyer || null, completed_at: listing.completedAt || null, updated_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const { error: deleteImagesError } = await supabaseAdmin.from("app_listing_images").delete().eq("listing_id", listing.id);
  if (deleteImagesError) return NextResponse.json({ error: deleteImagesError.message }, { status: 500 });
  const images = (listing.images || []).map((image: any, index: number) => ({ id: image.id, listing_id: listing.id, name: image.name || `${String(index + 1).padStart(2, "0")}.jpg`, source_url: image.storagePath ? null : image.src, storage_path: image.storagePath || null, display_order: index }));
  if (images.length) {
    const { error: imageError } = await supabaseAdmin.from("app_listing_images").insert(images);
    if (imageError) return NextResponse.json({ error: imageError.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
