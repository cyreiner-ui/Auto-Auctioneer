import { NextResponse } from "next/server";
import { debugFindItemAcrossKeywords } from "@/lib/finder-service";
import { requireStaff } from "@/lib/staff-auth";

// Collapses the per-keyword probe list down to the one thing staff actually want to know: did
// any keyword's live search turn this item up, and if so which one. Keyword searches that
// themselves failed (network error, eBay outage, etc.) are surfaced separately — a "not found"
// caused by a search failure isn't the same as a genuine absence from eBay's results.
function summarize(itemId: string, probes: Awaited<ReturnType<typeof debugFindItemAcrossKeywords>>) {
  const match = probes.find((probe) => probe.found);
  const failedKeywords = probes.filter((probe) => probe.error).map((probe) => probe.phrase);
  return match
    ? { itemId, found: true as const, keyword: match.phrase, matchedTitle: match.matchedTitle, failedKeywords }
    : { itemId, found: false as const, failedKeywords };
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
  try { return NextResponse.json(summarize(itemId, await debugFindItemAcrossKeywords(itemId))); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not run the finder debugger." }, { status: 500 }); }
}
