import { NextResponse } from "next/server";
import { appToken } from "@/lib/ebay-finder";
import { ebayApiBaseUrl } from "@/lib/ebay-endpoints";
import { requireStaff } from "@/lib/staff-auth";

// THROWAWAY: one-off probe for whether this eBay dev account has production access to the
// limited-release/experimental searchByImage Browse API method (eBay's own docs: "available to
// select developers approved by business units" — not granted by default alongside the ordinary
// keyword-search credentials this app already has). Not supported in eBay's Sandbox at all, so
// this always hits the production host regardless of EBAY_ENVIRONMENT. Delete this route (and its
// staff UI page) once the answer is known — it exists only to decide whether a gaucho-knife finder
// can use image search at all, not as a shipped feature.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl.trim() : "";
  if (!imageUrl) return NextResponse.json({ error: "Provide an image URL to test with." }, { status: 400 });
  try {
    const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
    if (!imageResponse.ok) return NextResponse.json({ error: `Could not fetch that image URL (${imageResponse.status}).` }, { status: 400 });
    const imageBase64 = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");
    const token = await appToken();
    const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const url = new URL(`${ebayApiBaseUrl("production")}/buy/browse/v1/item_summary/search_by_image`);
    url.searchParams.set("limit", "5");
    const ebayResponse = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": marketplace, "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageBase64 }),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await ebayResponse.text();
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* eBay sometimes returns non-JSON error bodies */ }
    return NextResponse.json({ status: ebayResponse.status, approved: ebayResponse.ok, body: parsed });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "searchByImage probe failed." }, { status: 500 }); }
}
