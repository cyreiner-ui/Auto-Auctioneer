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
// Sheffield-only negative keyword: these specific makers produced (near) exclusively stainless
// steel cutlery, even on listings that don't explicitly say "stainless" — a real production-history
// fact staff supplied, not something inferable from text patterns alone. Checked unconditionally,
// ahead of (and regardless of) any other material wording the listing happens to use. Several of
// these are already treated as stainless/kitchen-cutlery brands in this codebase's pocket-knife
// test fixtures (tests/finder-contract.test.mjs: "Regent Sherwood", "Tramontina Ekco Stainless",
// "Rogers Bros"). Regent, Crown Crest, Lewis Rose & Co, Landers Frary & Clark, Sherwood,
// Tramontina, Ekco, Rogers Bros/Wm Rogers, Lamson (& Goodnow), Cheltenham, Trustwell Bros,
// Westall Richardson, Hallmark Blades, John McClory (& Sons)/Scotia. Every multi-word entry uses
// `[\s,]*` (not just `\s*`) between name parts so a listing punctuated as "Lewis, Rose & Co." still
// matches — a real miss found in production ("Lewis, Rose & Co. Ltd." slipped through qualified
// with the old whitespace-only separator).
const knownStainlessSheffieldBrandsPattern = /\b(?:regent|crown\s*crest|lewis[\s,]*rose(?:[\s,]*(?:&|and)\s*co\.?)?|landers[\s,]*frary(?:[\s,]*(?:&|and)\s*clark)?|sherwood|tramontina|ekco|rogers\s*bros|wm\.?\s*rogers|lamson(?:[\s,]*(?:&|and)\s*goodnow)?|cheltenham|trustwell\s*bro(?:thers|s)\.?|westall[\s,]*richardson|hallmark\s*blades|mc\s*clory|scotia)\b/i;

// Sheffield-only negative keyword, weaker/broader than the brand list above: era and style wording
// that correlates with the post-war shift to stainless flatware in this dataset (e.g. "SHEFFIELD
// ENGLAND MODE DANISH WHEAT ... MCM", "Sheffield England Mid Century Modern") — genuine antique
// carbon-steel sets in this dataset don't use this wording. Checked regardless of brand/explicit
// material wording, same as the brand list.
const stainlessEraPattern = /\b(?:mcm|mid[\s-]?century(?:\s+modern)?|danish)\b/i;

// Sheffield-only negative keyword: "faux" (imitation) stag horn/antler/pearl handles correlate with
// later, mass-produced (stainless) sets in this dataset, as opposed to "real"/"genuine" stag horn.
const fauxHandlePattern = /\bfaux\b/i;

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

// Sheffield-only: a Gemini vision call only pays for itself once a run's text pass already found a
// genuinely large crop of leads to narrow down. Below this, every Sheffield item still pending on
// vision (case-ambiguous, or case/ceiling already known from text but material unconfirmed — see
// initialCarvingSetRow) is rejected outright instead of spending a vision call (see
// lib/finder-service.ts's startFinderRun, which counts candidates that passed every text check and
// are within the flat $200 ceiling as this run's "how many good leads" signal, since text alone
// rarely marks a Sheffield row "qualified" outright anymore). German has no equivalent gate — every
// case/piece-ambiguous German item still falls to vision regardless of run volume.
export const SHEFFIELD_VISION_MIN_QUALIFIED = 30;
export function sheffieldVisionEligible(eligibleCount: number): boolean {
  return eligibleCount > SHEFFIELD_VISION_MIN_QUALIFIED;
}

export type CarvingSetVisionResult = {
  hasCase: boolean;
  pieceCount: number;
  confidence: number;
  uncertaintyReason: string;
  material: "carbon_steel" | "stainless_steel" | "indeterminate";
};

export { VisionBudgetError, VisionQuotaError };

const CARVING_SET_MATERIALS = ["carbon_steel", "stainless_steel", "indeterminate"] as const;

// Case presence (and, for German, piece count) were always resolved here; material (carbon steel
// vs. stainless) is now also asked in this same call, folded into the same schema rather than a
// second Gemini call — and, since every surviving Sheffield candidate now reaches this call to
// confirm material (see initialCarvingSetRow), not just case-ambiguous ones, this is Sheffield's
// only real check against the photo, not merely a case-ambiguous fallback. Still only ever *acted
// on* for Sheffield (see evaluateCarvingSetVision) — German qualifies on either steel type, so its
// material answer is simply ignored downstream.
export async function analyzeCarvingSetWithGemini(input: { title: string; description: string; imageUrl: string }): Promise<CarvingSetVisionResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  await reserveUsage();
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const prompt = `Analyze this eBay listing for an antique/vintage carving set buyer. A carving set is a carving knife plus a matching serving fork, and often a sharpening steel, typically kept in a fitted presentation case or box. Determine: whether a case or box is visible in the photo, or clearly stated as included; the total number of physical pieces in the set (knife, fork, steel, etc — do not count the case itself as a piece, and do not count repeated views of the same set); and the blade material. First check whether any text is stamped, engraved, or etched directly on the blade itself indicating material (e.g. "STAINLESS", "STAINLESS STEEL", "18/8", "RUSTLESS") — if so, that marking is decisive: answer stainless_steel or carbon_steel to match it, even if the blade's color/patina looks otherwise. Only when no such marking is visible or legible, fall back to the visual appearance of the blades (color, shine, any patina/discoloration, staining): carbon_steel looks like a dull gray tone, visible patina, or light surface staining/rust, while stainless_steel looks bright and uniformly silver with no patina. Answer indeterminate only if neither a legible marking nor a clear enough photo of the blades is available. If the photo is unclear, ambiguous, or shows something other than a carving set, lower confidence and explain why. Title: ${input.title.slice(0, 300)}. Description: ${input.description.slice(0, 1200)}.`;
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
          required: ["hasCase", "pieceCount", "confidence", "uncertaintyReason", "material"],
          properties: {
            hasCase: { type: "BOOLEAN" },
            pieceCount: { type: "INTEGER", minimum: 0 },
            confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
            uncertaintyReason: { type: "STRING" },
            material: { type: "STRING", enum: [...CARVING_SET_MATERIALS] },
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
    typeof parsed.confidence !== "number" ||
    typeof parsed.uncertaintyReason !== "string" ||
    typeof parsed.material !== "string" ||
    !CARVING_SET_MATERIALS.includes(parsed.material as typeof CARVING_SET_MATERIALS[number])
  ) throw new Error("Gemini returned an invalid carving set analysis.");
  return parsed as CarvingSetVisionResult;
}

export type CarvingSetVisionDecision = {
  confident: boolean;
  ceiling: number | null;
  // Set only when the item is definitively rejected regardless of price/shipping (low
  // confidence, no case, an unresolvable German piece count, or — Sheffield only — a confident
  // stainless-steel material reading).
  reason: string | null;
};

// Pure decision logic over an already-fetched vision result — no I/O, so it's cheaply testable on
// its own. The shipping lookup and final price/ceiling comparison stay in finder-service.ts,
// mirroring how the pocket-knife pipeline splits vision classification from the shipping fetch.
export function evaluateCarvingSetVision(group: CarvingSetGroup, vision: CarvingSetVisionResult, confidenceThreshold: number): CarvingSetVisionDecision {
  const confident = vision.confidence >= confidenceThreshold;
  const ceiling = carvingSetCeiling(group, group === "german" ? vision.pieceCount : null);
  // Sheffield only, and only an unconditional "stainless_steel" reading rejects — a confident
  // "carbon_steel" or an honest "indeterminate" both pass through, matching the text pipeline's own
  // default-accept-unless-negative-signal philosophy (see initialCarvingSetRow). German ignores
  // vision.material entirely, exactly as it ignores the text-based material check today.
  const stainlessConfirmed = group === "sheffield" && vision.material === "stainless_steel";
  const reason = !confident ? (vision.uncertaintyReason || "low_confidence")
    : stainlessConfirmed ? "stainless_steel_vision"
    : !vision.hasCase ? "no_case"
    : ceiling == null ? "invalid_count"
    : null;
  return { confident, ceiling, reason };
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

  // A free-text eBay search for "sheffield/german carving set" can surface listings that never
  // actually contain "carving set"/"carving knife and fork" wording at all (e.g. a cased pocket
  // knife, or unrelated cutlery, that merely shares a keyword's brand/region name) — reject those
  // outright before any case/material logic below ever runs.
  if (!text.isCarvingSet) return { ...base, ...categoryFields, status: "rejected", reason: "not_carving_set", processed_at: new Date().toISOString() };

  // Material is resolved from text alone, never vision, and only ever applies to Sheffield —
  // German qualifies on either steel type. Most real listings say neither "carbon steel" nor
  // "stainless" at all, so this can't be an explicit-match-required check — it defaults to
  // accepting (assumed carbon steel) unless a negative signal says otherwise: any "stainless"
  // mention in the title or description (an unconditional negative keyword, same as the known-
  // stainless-only makers below — even a listing that also says "carbon steel" is rejected rather
  // than trusted, since a listing claiming both is more likely wrong/misleading than genuinely
  // carbon steel), a known-stainless-only maker (these brands never produced carbon steel carving
  // sets, regardless of what an individual listing claims), post-war era/style wording, or "faux"
  // handle material — the latter two are weaker, dataset-derived correlations rather than
  // production-history facts, so they get their own reason strings (not "stainless_steel") to stay
  // diagnostic if they ever need to be dialed back. This only ever *rejects* outright on a negative
  // signal — it never itself confirms carbon steel; a surviving Sheffield candidate's material
  // stays merely assumed until the vision check below confirms it (see that comment for why).
  if (group === "sheffield") {
    const fullText = `${item.title} ${item.shortDescription}`;
    if (knownStainlessSheffieldBrandsPattern.test(fullText) || text.stainless) {
      return { ...base, ...categoryFields, status: "rejected", reason: "stainless_steel", processed_at: new Date().toISOString() };
    }
    if (stainlessEraPattern.test(fullText)) {
      return { ...base, ...categoryFields, status: "rejected", reason: "stainless_era_wording", processed_at: new Date().toISOString() };
    }
    if (fauxHandlePattern.test(fullText)) {
      return { ...base, ...categoryFields, status: "rejected", reason: "faux_handle", processed_at: new Date().toISOString() };
    }
  }

  const ceiling = carvingSetCeiling(group, text.pieceCount);

  // German only: case plus a usable piece count are enough to fully resolve from text alone, since
  // German has no material requirement at all. Sheffield never finalizes here even once text
  // confirms case — the checks above only ever *reject* on a negative material signal, they never
  // *confirm* carbon steel, so a surviving Sheffield candidate still needs a vision material check
  // (below) before it can qualify, even though its case/ceiling are already known.
  if (group === "german" && text.hasCase && ceiling != null) {
    const knownFields = {
      ...categoryFields,
      knife_count: 1 as const,
      contains_folding_knife: false as const,
      confidence: 0.95,
      detection_source: "text" as const,
      carving_has_case: true,
      carving_carbon_steel: null,
    };
    const deal = dealAgainstCeiling(item.itemPrice, item.shippingCost, ceiling);
    if (!deal.resolved) {
      if (deal.overBudgetOnPriceAlone) return { ...base, ...knownFields, status: "rejected", reason: "over_budget", processed_at: new Date().toISOString() };
      return { ...base, ...knownFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
    }
    return { ...base, ...knownFields, status: deal.qualifies ? "qualified" : "rejected", reason: deal.qualifies ? null : "over_budget", total_cost: deal.totalCost, cost_per_knife: deal.totalCost, processed_at: new Date().toISOString() };
  }

  // Sheffield's ceiling is always the flat $200 regardless of case/vision, so an obviously
  // overpriced candidate can still be rejected without spending a vision call on it — mirrors the
  // price-alone-already-over-budget shortcut the (now German-only) fast path above still uses; not
  // worth paying for a photo just to confirm what the price already rules out.
  if (group === "sheffield" && ceiling != null && item.itemPrice > ceiling) {
    return { ...base, ...categoryFields, status: "rejected", reason: "over_budget", processed_at: new Date().toISOString() };
  }

  // Text alone couldn't finalize this row: German still needs vision to confirm case and/or a
  // usable piece count, and Sheffield — whose case/ceiling may already be fully known from text —
  // still needs a vision material check (see analyzeCarvingSetWithGemini/evaluateCarvingSetVision)
  // before it can qualify, since the checks above only ever rule material out, never confirm it.
  // Same text-first/vision-fallback shape as the pocket-knife pipeline, but via
  // analyzeCarvingSetWithGemini instead of countKnivesWithGemini.
  const carvingCarbonSteel = group === "sheffield" ? true : null;
  if (!item.imageUrl) return { ...base, ...categoryFields, carving_carbon_steel: carvingCarbonSteel, status: "rejected", reason: "missing_image", processed_at: new Date().toISOString() };
  return { ...base, ...categoryFields, carving_carbon_steel: carvingCarbonSteel, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
}

export function refreshedCarvingSetRow(item: CarvingSetItem, keywordPhrases: string[], runId: string, existing: CarvingSetExistingRow | undefined, group: CarvingSetGroup) {
  const preservedShipping = existing?.shipping_source === "lookup" && existing.shipping_cost != null;
  const effectiveItem = item.shippingCost == null && preservedShipping
    ? { ...item, shippingCost: Number(existing!.shipping_cost), shippingCurrency: "USD" }
    : item;
  const fresh = initialCarvingSetRow(effectiveItem, keywordPhrases, runId, group);
  const freshRow = preservedShipping ? { ...fresh, shipping_source: "lookup" as const } : fresh;
  // NOTE: initialCarvingSetRow's return type is a union of object literals, and not every
  // branch includes `knife_count` — accessing it below is safe at runtime (missing means
  // undefined, same as null for this check) but fails `tsc`, which is why the build currently
  // runs with `typescript: { ignoreBuildErrors: true }` in next.config.ts.
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
  // Sheffield only: a previous vision call may have confirmed stainless steel (persisted as
  // carving_carbon_steel: false in processCarvingSetRow) even though text alone never asks vision
  // about material at initial discovery — that stale verdict must keep rejecting the item on a
  // later rescan where text is still case-ambiguous, exactly like the no_case check below, or it
  // would silently "re-qualify" a set already confirmed stainless.
  if (group === "sheffield" && existing.carving_carbon_steel === false) return { ...freshRow, ...knownFields, status: "rejected" as const, reason: "stainless_steel_vision", processed_at: new Date().toISOString() };
  if (existing.carving_has_case !== true) return { ...freshRow, ...knownFields, status: "rejected" as const, reason: "no_case", processed_at: new Date().toISOString() };
  if (ceiling == null) return { ...freshRow, ...knownFields, status: "rejected" as const, reason: "invalid_count", processed_at: new Date().toISOString() };
  const deal = dealAgainstCeiling(effectiveItem.itemPrice, effectiveItem.shippingCost, ceiling);
  if (!deal.resolved) {
    if (deal.overBudgetOnPriceAlone) return { ...freshRow, ...knownFields, status: "rejected" as const, reason: "over_budget", processed_at: new Date().toISOString() };
    return { ...freshRow, ...knownFields, status: "pending" as const, reason: null, next_attempt_at: new Date().toISOString() };
  }
  return { ...freshRow, ...knownFields, status: deal.qualifies ? "qualified" as const : "rejected" as const, reason: deal.qualifies ? null : "over_budget", total_cost: deal.totalCost, cost_per_knife: deal.totalCost, processed_at: new Date().toISOString() };
}
