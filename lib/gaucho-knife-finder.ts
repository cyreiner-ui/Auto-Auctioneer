// A deliberately separate algorithm from lib/finder-core.ts's pocket-knife pipeline and
// lib/carving-set-finder.ts's carving-set pipeline. Unlike either of those, discovery here leads
// with eBay's searchByImage Browse API method (staff-uploaded reference photos of the target
// gaucho/criollo/facón knife style) rather than keyword search — real gaucho knives are routinely
// mislabeled by sellers who don't recognize what they have ("letter opener," "silver dagger,"
// "ornate dagger"), so a positive-keyword requirement would throw away exactly the listings this
// feature exists to catch. Keyword search (finder_keywords, same table the other two categories
// use) is only a supplementary discovery net here. There is deliberately no price gate at launch —
// qualification is driven purely by whether Gemini vision judges the candidate's photo a match
// against the staff-curated reference photos.
import { imagePart, referenceImagePart, reserveUsage, VisionBudgetError, VisionQuotaError } from "./gemini-vision";
import { matchesNegativeKeyword } from "./finder-core";
import type { EbayFinderItem } from "./ebay-finder";

export { VisionBudgetError, VisionQuotaError };
// Re-exported for backward compatibility — this used to be defined here; it's now a shared
// utility in finder-core.ts since the pocket-knife pipeline's own negative-keyword filter needs
// the exact same substring-match behavior.
export { matchesNegativeKeyword };

export const GAUCHO_REFERENCE_IMAGE_BUCKET = "finder-reference-images";

// Must match the phrases seeded by supabase/migrations/028_finder_gaucho_knives.sql. These only
// drive the keyword-search supplement — see the module comment above for why there's no positive
// text requirement gating the image-search path.
export const GAUCHO_KNIFE_PHRASES = [
  "gaucho knife", "facon knife", "facón knife", "criollo knife", "cuchillo criollo",
  "verijero knife", "gaucho dagger", "caronero knife", "Franz Wenk", "Franz Wenk Solingen",
  "Scholberg", "Broqua Scholberg", "JU-CA knife", "Tandil knife", "alpaca gaucho knife",
  "Argentine gaucho knife",
];

// Image-search hits aren't found via any finder_keywords phrase, so lib/finder-service.ts's
// startFinderRun tags them with this synthetic marker instead (carrying which reference image
// produced the match, for staff auditability) — still round-tripping through the same
// keyword_phrases array every other category-dispatch point already keys off.
const IMAGE_SEARCH_PHRASE_PREFIX = "__image_search:";
export function imageSearchPhrase(referenceImageId: string) { return `${IMAGE_SEARCH_PHRASE_PREFIX}${referenceImageId}`; }

export function gauchoKnifeGroupForPhrases(phrases: string[]): boolean {
  return phrases.some((phrase) => (GAUCHO_KNIFE_PHRASES as readonly string[]).includes(phrase) || phrase.startsWith(IMAGE_SEARCH_PHRASE_PREFIX));
}

// Raw base64 for eBay's searchByImage request body — lib/ebay-finder.ts's searchEbayByImage
// wants the bare base64 string, not Gemini's {inlineData:{...}} wrapper, so this just unwraps
// referenceImagePart's result rather than duplicating the storage-download logic.
export async function referenceImageBase64(storagePath: string): Promise<string> {
  const part = await referenceImagePart(GAUCHO_REFERENCE_IMAGE_BUCKET, storagePath);
  return part.inlineData.data;
}

export type GauchoKnifeMatchResult = {
  matches: boolean;
  confidence: number;
  // null when no maker markings are visible/legible on the candidate — distinct from a
  // confident "false" (markings visible but inconsistent with the reference photos' maker).
  makerMatch: boolean | null;
  // 1-based index into the referenceImages array passed in, or null when not confidently one
  // specific reference.
  matchedReferenceIndex: number | null;
  notes: string;
};

const GAUCHO_MAX_REFERENCE_IMAGES = 5;

// One Gemini call, not one per reference image — generateContent's contents[].parts accepts an
// arbitrary number of inlineData image parts alongside text in a single request, so this composes
// to 1 text part + up to GAUCHO_MAX_REFERENCE_IMAGES reference images + 1 candidate image. Cheaper
// (one budget reservation, one round trip) than a call per reference, and lets the model directly
// compare every image in the same context.
export async function analyzeGauchoKnifeMatch(input: { title: string; description: string; candidateImageUrl: string; referenceImages: { storagePath: string }[] }): Promise<GauchoKnifeMatchResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  const references = input.referenceImages.slice(0, GAUCHO_MAX_REFERENCE_IMAGES);
  if (!references.length) throw new Error("No reference images are configured for the gaucho-knife finder.");
  await reserveUsage();
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const prompt = `Compare the LAST photo (the candidate, from an eBay listing) against the ${references.length} reference photo(s) that come before it, numbered 1 through ${references.length} in order. The reference photos show a specific style of gaucho/criollo/facón knife — a traditional Argentine/Uruguayan knife, often with an ornate silver or nickel-silver ("alpaca") handle and matching sheath. Sellers frequently mislabel genuine examples with generic titles like "letter opener," "silver dagger," or "ornate dagger," so judge purely by the candidate's visual blade shape, handle style, and overall form against the references — ignore the listing title/description except for any maker name or markings they mention. An ornate silver/nickel handle plus a narrow blade plus a sheath is NOT enough on its own to call it a match — that same surface combination is shared by several unrelated, commonly-confused items: Arabian/Middle Eastern khanjar or jambiya daggers (distinctively curved blade), East/South Asian ornamental daggers, European antique hunting daggers or Bowie-style fighting knives, and silver-handled flatware/carving/dinner-knife cutlery (flat, blunt, place-setting-style blade). Set matches to true only when the candidate's specific blade profile, guard, and handle/sheath construction plausibly match the criollo/gaucho style shown in the references, not merely "some kind of ornate bladed item." Separately, if any maker markings/hallmarks are visible and legible on the candidate (in the photo or the text), set makerMatch to true if they're consistent with the references' likely maker, false if they clearly indicate an unrelated maker, or leave it unset if no markings are visible/legible. If matches is true and the candidate most resembles one specific reference photo, set matchedReferenceIndex to that photo's number (1-based); otherwise leave it unset. Explain your reasoning briefly in notes, especially if uncertain, and note explicitly if you ruled out one of the lookalike categories above. Title: ${input.title.slice(0, 300)}. Description: ${input.description.slice(0, 1200)}.`;
  const referenceParts = await Promise.all(references.map((reference) => referenceImagePart(GAUCHO_REFERENCE_IMAGE_BUCKET, reference.storagePath)));
  const candidatePart = await imagePart(input.candidateImageUrl);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, ...referenceParts, candidatePart] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 300,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: ["matches", "confidence", "notes"],
          properties: {
            matches: { type: "BOOLEAN" },
            confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
            makerMatch: { type: "BOOLEAN" },
            matchedReferenceIndex: { type: "INTEGER" },
            notes: { type: "STRING" },
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
  const parsed = JSON.parse(text) as Partial<GauchoKnifeMatchResult>;
  if (typeof parsed.matches !== "boolean" || typeof parsed.confidence !== "number" || typeof parsed.notes !== "string") {
    throw new Error("Gemini returned an invalid gaucho-knife match analysis.");
  }
  return {
    matches: parsed.matches,
    confidence: parsed.confidence,
    makerMatch: typeof parsed.makerMatch === "boolean" ? parsed.makerMatch : null,
    matchedReferenceIndex: Number.isInteger(parsed.matchedReferenceIndex) ? (parsed.matchedReferenceIndex as number) : null,
    notes: parsed.notes,
  };
}

function baseRow(item: EbayFinderItem, keywordPhrases: string[], runId: string) {
  const totalCost = item.shippingCost != null ? Math.round((item.itemPrice + item.shippingCost) * 100) / 100 : null;
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
    // Display only — there is no price gate for this category (see the module comment above), so
    // nothing downstream compares these against a ceiling the way the other two categories do.
    total_cost: totalCost,
    cost_per_knife: totalCost,
  };
}

export type GauchoKnifeExistingRow = {
  status: string;
  reason: string | null;
  detection_source: string | null;
  confidence: number | string | null;
  gaucho_match_confidence: number | string | null;
  gaucho_maker_match: boolean | null;
  gaucho_matched_reference_id: string | null;
  gaucho_match_notes: string | null;
  shipping_cost: number | string | null;
  shipping_source: string | null;
};

// No text-only fast path exists for this category — a gaucho-knife match is inherently a visual
// judgment, not something resolvable from title/description text alone (unlike pocket-knife's
// stated counts or carving-set's case/material/piece-count wording). Every surviving candidate
// goes straight to "pending" and always takes the vision path on its first tick.
export function initialGauchoKnifeRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, negativePhrases: string[]) {
  const base = baseRow(item, keywordPhrases, runId);
  const categoryFields = { item_category: "gaucho_knife" as const, knife_count: 1 as const, contains_folding_knife: false as const };
  if (item.currency !== "USD") return { ...base, ...categoryFields, status: "rejected", reason: "non_usd_currency", processed_at: new Date().toISOString() };
  if (item.shippingCost != null && item.shippingCurrency !== "USD") return { ...base, ...categoryFields, status: "rejected", reason: "non_usd_shipping", processed_at: new Date().toISOString() };
  if (!Number.isFinite(item.itemPrice) || item.itemPrice < 0) return { ...base, ...categoryFields, status: "rejected", reason: "invalid_price", processed_at: new Date().toISOString() };
  if (item.itemEndDate && new Date(item.itemEndDate).getTime() <= Date.now()) return { ...base, ...categoryFields, status: "rejected", reason: "ended", processed_at: new Date().toISOString() };
  const negativeMatch = matchesNegativeKeyword(item.title, item.shortDescription, negativePhrases);
  if (negativeMatch) return { ...base, ...categoryFields, status: "rejected", reason: "negative_keyword_match", gaucho_match_notes: `Matched negative keyword: "${negativeMatch}"`, processed_at: new Date().toISOString() };
  if (!item.imageUrl) return { ...base, ...categoryFields, status: "rejected", reason: "missing_image", processed_at: new Date().toISOString() };
  return { ...base, ...categoryFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
}

export function refreshedGauchoKnifeRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, existing: GauchoKnifeExistingRow | undefined, negativePhrases: string[]) {
  const preservedShipping = existing?.shipping_source === "lookup" && existing.shipping_cost != null;
  const effectiveItem = item.shippingCost == null && preservedShipping
    ? { ...item, shippingCost: Number(existing!.shipping_cost), shippingCurrency: "USD" }
    : item;
  const fresh = initialGauchoKnifeRow(effectiveItem, keywordPhrases, runId, negativePhrases);
  const freshRow = preservedShipping ? { ...fresh, shipping_source: "lookup" as const } : fresh;
  // Only reuse a previous vision verdict when today's negative-keyword/validation re-check still
  // leaves the row pending — a fresh rejection always wins (e.g. a newly added negative keyword),
  // same self-correcting behavior the other two categories rely on. This is what avoids
  // re-spending a Gemini call on a listing already vision-checked on an earlier scan.
  if (!existing || existing.detection_source !== "vision" || freshRow.status !== "pending") return freshRow;
  return {
    ...freshRow,
    status: existing.status === "qualified" ? "qualified" as const : "rejected" as const,
    reason: existing.reason,
    detection_source: "vision" as const,
    confidence: existing.confidence,
    gaucho_match_confidence: existing.gaucho_match_confidence,
    gaucho_maker_match: existing.gaucho_maker_match,
    gaucho_matched_reference_id: existing.gaucho_matched_reference_id,
    gaucho_match_notes: existing.gaucho_match_notes,
    next_attempt_at: null,
    processed_at: new Date().toISOString(),
  };
}
