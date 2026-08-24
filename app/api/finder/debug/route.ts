import { NextResponse } from "next/server";
import { debugFindItemAcrossKeywords, debugFindItemViaGauchoImageSearch } from "@/lib/finder-service";
import { requireStaff } from "@/lib/staff-auth";

// Collapses the per-keyword probe list, plus the gaucho-knife reference-photo image-search probes,
// down to the one thing staff actually want to know: did any live search turn this item up, and by
// which method. Keyword searches (and image searches) that themselves failed (network error, eBay
// outage, etc.) are surfaced separately — a "not found" caused by a search failure isn't the same
// as a genuine absence from eBay's results. Image search is checked in addition to keywords, not
// instead of them, because real gaucho knives are routinely mislabeled by sellers and are expected
// to surface mainly through image search rather than any keyword match (see
// lib/gaucho-knife-finder.ts's module comment) — reporting keyword results alone would make image
// search look broken even when it's working.
function summarize(itemId: string, keywordProbes: Awaited<ReturnType<typeof debugFindItemAcrossKeywords>>, imageProbes: Awaited<ReturnType<typeof debugFindItemViaGauchoImageSearch>>) {
  const keywordMatch = keywordProbes.find((probe) => probe.found);
  const imageMatch = imageProbes.find((probe) => probe.found);
  const failedKeywords = keywordProbes.filter((probe) => probe.error).map((probe) => probe.phrase);
  const failedImageSearches = imageProbes.filter((probe) => probe.error).length;
  const base = { itemId, failedKeywords, imageSearchConfigured: imageProbes.length > 0, imageSearchesRun: imageProbes.length, failedImageSearches };
  if (imageMatch) return { ...base, found: true as const, keyword: null, matchedTitle: imageMatch.matchedTitle, foundVia: "image_search" as const };
  if (keywordMatch) return { ...base, found: true as const, keyword: keywordMatch.phrase, matchedTitle: keywordMatch.matchedTitle, foundVia: "keyword" as const };
  return { ...base, found: false as const };
}

// Same eBay-search-heavy workload as /api/finder/run's scan phase (every enabled keyword,
// each up to a few paginated Browse API calls), so it needs the same generous time budget.
export const runtime = "nodejs";
export const maxDuration = 60;

// Staff paste either the bare eBay item id or a full listing URL (e.g.
// https://www.ebay.com/itm/287535686773) — pull the numeric id out of either.
function extractItemId(raw: string): string {
  const digits = raw.match(/(\d{9,})/);
  return digits ? digits[1] : raw.trim();
}

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const itemId = typeof body?.itemId === "string" ? extractItemId(body.itemId) : "";
  if (!itemId) return NextResponse.json({ error: "Provide an eBay item id or listing URL." }, { status: 400 });
  try {
    const [keywordProbes, imageProbes] = await Promise.all([debugFindItemAcrossKeywords(itemId), debugFindItemViaGauchoImageSearch(itemId)]);
    return NextResponse.json(summarize(itemId, keywordProbes, imageProbes));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not run the finder debugger." }, { status: 500 }); }
}
