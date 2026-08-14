// A deliberately separate algorithm from lib/finder-core.ts's pocket-knife pipeline. A carving
// set (a carving knife + matching fork + often a sharpening steel, usually in a fitted case) is a
// different kind of item with different rules (a case requirement, a material requirement, and
// flat/tiered pricing instead of cost-per-knife) — it does not belong bolted onto the pocket-knife
// text patterns, knife-count logic, or Gemini vision schema, all of which stay untouched.
import { VisionBudgetError, VisionQuotaError, imagePart, reserveUsage } from "./gemini-vision";

export type CarvingSetGroup = "sheffield" | "german";

// The only two finder_keywords phrases this algorithm ever runs against — seeded by
// supabase/migrations/020_finder_carving_sets.sql. Everything else keeps going through the
// pocket-knife pipeline in lib/finder-core.ts/lib/finder-service.ts, untouched.
export const CARVING_SET_KEYWORDS: Record<CarvingSetGroup, string> = {
  sheffield: "sheffield carving set",
  german: "german carving set",
};

export function carvingSetGroupForPhrases(phrases: string[]): CarvingSetGroup | null {
  if (phrases.includes(CARVING_SET_KEYWORDS.sheffield)) return "sheffield";
  if (phrases.includes(CARVING_SET_KEYWORDS.german)) return "german";
  return null;
}

// Flat list of the two phrases above — used by lib/finder-service.ts to scope a manual run, the
// results/counts/archived queries, and qualification emails to just this category (via a
// keyword_phrases array-overlap check), without adding a category column to finder_keywords.
export const CARVING_SET_PHRASES: string[] = Object.values(CARVING_SET_KEYWORDS);

const carvingSetPattern = /\bcarving\s+(?:set|knife\s*(?:and|&)\s*fork(?:\s+set)?)\b/i;
// Explicit case/box wording only — never a bare /case/i. W.R. Case & Sons is a real, common knife
// brand, so "Case Carving Set" (the brand) must not be misread as "a carving set with a case."
const caseIndicatorPattern = /\b(?:with\s+(?:its\s+|a\s+|the\s+)?(?:original\s+|fitted\s+|presentation\s+)?case\b|\bin\s+(?:its\s+|a\s+|the\s+)?(?:original\s+|fitted\s+|presentation\s+)?case\b|\bcased\b|\bboxed\b|\bpresentation\s+(?:case|box)\b|\bfitted\s+(?:case|box)\b|\boriginal\s+box\b)/i;
const carbonSteelPattern = /\bcarbon[\s-]*steel\b/i;
const stainlessPattern = /\bstainless(?:[\s-]*steel)?\b/i;
const pieceCountPattern = /\b(\d{1,2})[\s-]*(?:pcs?|pieces?)\b/i;

export type CarvingSetTextSignals = {
  isCarvingSet: boolean;
  hasCase: boolean;
  pieceCount: number | null;
  carbonSteel: boolean;
  stainless: boolean;
};

// Pure fact-extraction only — this does not decide qualification itself, since that depends on
// which brand group matched (Sheffield vs. German), which this function has no visibility into.
export function analyzeCarvingSetText(title: string, description = ""): CarvingSetTextSignals {
  const text = `${title} ${description}`.replace(/\s+/g, " ").trim();
  const pieceMatch = text.match(pieceCountPattern);
  const pieceCount = pieceMatch ? Number(pieceMatch[1]) : null;
  return {
    isCarvingSet: carvingSetPattern.test(text),
    hasCase: caseIndicatorPattern.test(text),
    pieceCount: pieceCount && pieceCount > 0 ? pieceCount : null,
    carbonSteel: carbonSteelPattern.test(text),
    stainless: stainlessPattern.test(text),
  };
}

// Sheffield: flat $200 all-in, regardless of piece count (carbon-steel-only is enforced
// separately, not part of this formula). German: no material restriction, tiered by piece count —
// $10/piece + $15 (2pc=$35, 3pc=$45, 4pc=$55, 5pc=$65, same slope beyond 5). Returns null when the
// German group's piece count isn't resolvable yet (must fall to vision).
export function carvingSetCeiling(group: CarvingSetGroup, pieceCount: number | null): number | null {
  if (group === "sheffield") return 200;
  return pieceCount != null && pieceCount >= 2 ? pieceCount * 10 + 15 : null;
}

export type CarvingSetVisionResult = {
  hasCase: boolean;
  pieceCount: number;
  carbonSteel: boolean;
  confidence: number;
  uncertaintyReason: string;
};

export { VisionBudgetError, VisionQuotaError };

export async function analyzeCarvingSetWithGemini(input: { title: string; description: string; imageUrl: string }): Promise<CarvingSetVisionResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  await reserveUsage();
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const prompt = `Analyze this eBay listing for an antique/vintage carving set buyer. A carving set is a carving knife plus a matching serving fork, and often a sharpening steel, typically kept in a fitted presentation case or box. Determine: whether a case or box is visible in the photo, or clearly stated as included; the total number of physical pieces in the set (knife, fork, steel, etc — do not count the case itself as a piece, and do not count repeated views of the same set); and whether the blade is carbon steel (look for a dark or patina finish, or the absence of any "stainless" marking) as opposed to stainless steel. If the photo is unclear, ambiguous, or shows something other than a carving set, lower confidence and explain why. Title: ${input.title.slice(0, 300)}. Description: ${input.description.slice(0, 1200)}.`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, await imagePart(input.imageUrl)] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 250,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: ["hasCase", "pieceCount", "carbonSteel", "confidence", "uncertaintyReason"],
          properties: {
            hasCase: { type: "BOOLEAN" },
            pieceCount: { type: "INTEGER", minimum: 0 },
            carbonSteel: { type: "BOOLEAN" },
            confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
            uncertaintyReason: { type: "STRING" },
          },
        },
      },
    }),
  });
  if (response.status === 429) throw new VisionQuotaError("Gemini free quota is temporarily exhausted.");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini analysis failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}.`);
  }
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text || "";
  const parsed = JSON.parse(text) as Partial<CarvingSetVisionResult>;
  if (
    typeof parsed.hasCase !== "boolean" ||
    !Number.isInteger(parsed.pieceCount) ||
    typeof parsed.carbonSteel !== "boolean" ||
    typeof parsed.confidence !== "number" ||
    typeof parsed.uncertaintyReason !== "string"
  ) throw new Error("Gemini returned an invalid carving set analysis.");
  return parsed as CarvingSetVisionResult;
}

export type CarvingSetVisionDecision = {
  confident: boolean;
  materialOk: boolean;
  ceiling: number | null;
  // Set only when the item is definitively rejected regardless of price/shipping (low
  // confidence, no case, wrong material, or an unresolvable German piece count).
  reason: string | null;
};

// Pure decision logic over an already-fetched vision result — no I/O, so it's cheaply testable on
// its own. The shipping lookup and final price/ceiling comparison stay in finder-service.ts,
// mirroring how the pocket-knife pipeline splits vision classification from the shipping fetch.
export function evaluateCarvingSetVision(group: CarvingSetGroup, vision: CarvingSetVisionResult, confidenceThreshold: number): CarvingSetVisionDecision {
  const confident = vision.confidence >= confidenceThreshold;
  const materialOk = group === "german" || vision.carbonSteel;
  const ceiling = carvingSetCeiling(group, group === "german" ? vision.pieceCount : null);
  const reason = !confident ? (vision.uncertaintyReason || "low_confidence")
    : !vision.hasCase ? "no_case"
    : !materialOk ? "stainless_steel"
    : ceiling == null ? "invalid_count"
    : null;
  return { confident, materialOk, ceiling, reason };
}

export type CarvingSetItem = {
  itemId: string;
  title: string;
  shortDescription: string;
  itemWebUrl: string;
  imageUrl: string | null;
  itemPrice: number;
  shippingCost: number | null;
  shippingCurrency: string;
  currency: string;
  buyingOptions: string[];
  itemEndDate: string | null;
};

function baseRow(item: CarvingSetItem, keywordPhrases: string[], runId: string) {
  return {
    ebay_item_id: item.itemId,
    run_id: runId,
    keyword_phrases: keywordPhrases,
    title: item.title,
    short_description: item.shortDescription,
    ebay_url: item.itemWebUrl,
    image_url: item.imageUrl,
    item_price: Number.isFinite(item.itemPrice) ? item.itemPrice : 0,
    shipping_cost: item.shippingCost,
    currency: item.currency,
    buying_options: item.buyingOptions,
    item_end_date: item.itemEndDate,
  };
}

function dealAgainstCeiling(itemPrice: number, shippingCost: number | null, ceiling: number) {
  if (shippingCost == null) return { resolved: false as const, overBudgetOnPriceAlone: itemPrice > ceiling };
  const totalCost = Math.round((itemPrice + shippingCost) * 100) / 100;
  return { resolved: true as const, totalCost, qualifies: totalCost <= ceiling };
}

export type CarvingSetExistingRow = {
  knife_count: number | null;
  confidence: number | null;
  detection_source: string | null;
  carving_piece_count: number | null;
  carving_has_case: boolean | null;
  carving_carbon_steel: boolean | null;
  shipping_cost: number | string | null;
  shipping_source: string | null;
};

// Mirrors initialRow's contract in lib/finder-service.ts (same base fields, same status/pending
// shape for the finder_items upsert) but via wholly separate qualification logic. knife_count is
// always written as 1 — a carving set is one unit; piece count only ever feeds the German pricing
// formula, never the qualification divisor (that's the exact "3 piece set" miscount risk this
// separation exists to avoid).
export function initialCarvingSetRow(item: CarvingSetItem, keywordPhrases: string[], runId: string, group: CarvingSetGroup) {
  const base = baseRow(item, keywordPhrases, runId);
  if (item.currency !== "USD") return { ...base, status: "rejected", reason: "non_usd_currency", processed_at: new Date().toISOString() };
  if (item.shippingCost != null && item.shippingCurrency !== "USD") return { ...base, status: "rejected", reason: "non_usd_shipping", processed_at: new Date().toISOString() };
  if (!Number.isFinite(item.itemPrice) || item.itemPrice < 0) return { ...base, status: "rejected", reason: "invalid_price", processed_at: new Date().toISOString() };
  if (item.itemEndDate && new Date(item.itemEndDate).getTime() <= Date.now()) return { ...base, status: "rejected", reason: "ended", processed_at: new Date().toISOString() };

  const text = analyzeCarvingSetText(item.title, item.shortDescription);
  const categoryFields = { item_category: "carving_set" as const, carving_piece_count: text.pieceCount };

  // Sheffield-only: an explicit "stainless" mention (with no "carbon steel" mention alongside it)
  // is a final, text-only reject — the seller has already told us the material, no vision needed.
  if (group === "sheffield" && text.stainless && !text.carbonSteel) {
    return { ...base, ...categoryFields, status: "rejected", reason: "stainless_steel", processed_at: new Date().toISOString() };
  }

  const materialConfirmed = group === "german" || text.carbonSteel;
  const ceiling = carvingSetCeiling(group, text.pieceCount);
  if (text.hasCase && materialConfirmed && ceiling != null) {
    const knownFields = {
      ...categoryFields,
      knife_count: 1 as const,
      contains_folding_knife: false as const,
      confidence: 0.95,
      detection_source: "text" as const,
      carving_has_case: true,
      carving_carbon_steel: group === "sheffield" ? true : text.carbonSteel,
    };
    const deal = dealAgainstCeiling(item.itemPrice, item.shippingCost, ceiling);
    if (!deal.resolved) {
      if (deal.overBudgetOnPriceAlone) return { ...base, ...knownFields, status: "rejected", reason: "over_budget", processed_at: new Date().toISOString() };
      return { ...base, ...knownFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
    }
    return { ...base, ...knownFields, status: deal.qualifies ? "qualified" : "rejected", reason: deal.qualifies ? null : "over_budget", total_cost: deal.totalCost, cost_per_knife: deal.totalCost, processed_at: new Date().toISOString() };
  }

  // Text alone couldn't confirm everything (case — and possibly, for Sheffield, material, or for
  // German, a usable piece count) — fall to vision, same text-first/vision-fallback shape as the
  // pocket-knife pipeline, but via analyzeCarvingSetWithGemini instead of countKnivesWithGemini.
  if (!item.imageUrl) return { ...base, ...categoryFields, status: "rejected", reason: "missing_image", processed_at: new Date().toISOString() };
  return { ...base, ...categoryFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
}

export function refreshedCarvingSetRow(item: CarvingSetItem, keywordPhrases: string[], runId: string, existing: CarvingSetExistingRow | undefined, group: CarvingSetGroup) {
  const preservedShipping = existing?.shipping_source === "lookup" && existing.shipping_cost != null;
  const effectiveItem = item.shippingCost == null && preservedShipping
    ? { ...item, shippingCost: Number(existing!.shipping_cost), shippingCurrency: "USD" }
    : item;
  const fresh = initialCarvingSetRow(effectiveItem, keywordPhrases, runId, group);
  const freshRow = preservedShipping ? { ...fresh, shipping_source: "lookup" as const } : fresh;
  // Prefer fresh text re-derivation whenever it's conclusive; only reuse a previously
  // vision-confirmed case/material/piece-count when today's text re-analysis is still ambiguous —
  // this is what lets an already-fixed parser bug self-correct for free on the next scan.
  if (!existing || existing.detection_source !== "vision" || existing.knife_count == null || freshRow.knife_count != null) return freshRow;

  const pieceCount = existing.carving_piece_count;
  const ceiling = carvingSetCeiling(group, pieceCount);
  const knownFields = {
    item_category: "carving_set" as const,
    knife_count: 1 as const,
    contains_folding_knife: false as const,
    confidence: existing.confidence,
    detection_source: "vision" as const,
    carving_piece_count: pieceCount,
    carving_has_case: existing.carving_has_case,
    carving_carbon_steel: existing.carving_carbon_steel,
  };
  if (existing.carving_has_case !== true) return { ...freshRow, ...knownFields, status: "rejected" as const, reason: "no_case", processed_at: new Date().toISOString() };
  const materialConfirmed = group === "german" || existing.carving_carbon_steel === true;
  if (!materialConfirmed) return { ...freshRow, ...knownFields, status: "rejected" as const, reason: "stainless_steel", processed_at: new Date().toISOString() };
  if (ceiling == null) return { ...freshRow, ...knownFields, status: "rejected" as const, reason: "invalid_count", processed_at: new Date().toISOString() };
  const deal = dealAgainstCeiling(effectiveItem.itemPrice, effectiveItem.shippingCost, ceiling);
  if (!deal.resolved) {
    if (deal.overBudgetOnPriceAlone) return { ...freshRow, ...knownFields, status: "rejected" as const, reason: "over_budget", processed_at: new Date().toISOString() };
    return { ...freshRow, ...knownFields, status: "pending" as const, reason: null, next_attempt_at: new Date().toISOString() };
  }
  return { ...freshRow, ...knownFields, status: deal.qualifies ? "qualified" as const : "rejected" as const, reason: deal.qualifies ? null : "over_budget", total_cost: deal.totalCost, cost_per_knife: deal.totalCost, processed_at: new Date().toISOString() };
}
