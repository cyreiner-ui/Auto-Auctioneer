// A deliberately separate algorithm from lib/finder-core.ts's pocket-knife pipeline,
// lib/carving-set-finder.ts's carving-set pipeline, and lib/gaucho-knife-finder.ts's gaucho-knife
// pipeline. Same shape as gaucho-knife-finder.ts: discovery leads with eBay's searchByImage Browse
// API method (staff-uploaded reference photos of the specific target maté gourd) rather than
// keyword search, because sellers routinely list these generically ("gourd cup," "yerba mate,"
// "mate cup") without the specific style/maker wording a positive-keyword requirement would need.
// Keyword search (finder_keywords, same table every other category uses) is only a supplementary
// discovery net here. There is deliberately no price gate — qualification is driven purely by
// whether Gemini vision judges the candidate's photo a match against the staff-curated reference
// photos of the one specific gourd being sought.
import { imagePart, referenceImagePart, reserveUsage, VisionBudgetError, VisionQuotaError } from "./gemini-vision";
import { matchesNegativeKeyword } from "./finder-core";
import type { EbayFinderItem } from "./ebay-finder";

export { VisionBudgetError, VisionQuotaError };
export { matchesNegativeKeyword };

export const MATE_GOURD_REFERENCE_IMAGE_BUCKET = "finder-reference-images";

// Must match the phrases seeded by supabase/migrations/044_finder_mate_gourds.sql. These only
// drive the keyword-search supplement — see the module comment above for why there's no positive
// text requirement gating the image-search path.
export const MATE_GOURD_PHRASES = [
  "mate gourd", "yerba mate gourd", "mate cup gourd", "calabaza mate", "mate gourd silver",
  "antique mate gourd", "argentine mate gourd", "uruguayan mate gourd", "guampa", "poro mate",
  "mate gourd alpaca",
];

// Image-search hits aren't found via any finder_keywords phrase, so lib/finder-service.ts's
// startFinderRun tags them with this synthetic marker instead (carrying which reference image
// produced the match, for staff auditability) — still round-tripping through the same
// keyword_phrases array every other category-dispatch point already keys off. Deliberately a
// different prefix from lib/gaucho-knife-finder.ts's own IMAGE_SEARCH_PHRASE_PREFIX — sharing one
// would make a mate-gourd row's synthetic phrase also match gauchoKnifeGroupForPhrases's
// startsWith check, exactly the cross-finder "mixing" bug this whole prefix scheme exists to avoid.
const IMAGE_SEARCH_PHRASE_PREFIX = "__mate_gourd_image_search:";
export function imageSearchPhrase(referenceImageId: string) { return `${IMAGE_SEARCH_PHRASE_PREFIX}${referenceImageId}`; }

export function mateGourdGroupForPhrases(phrases: string[]): boolean {
  return phrases.some((phrase) => (MATE_GOURD_PHRASES as readonly string[]).includes(phrase) || phrase.startsWith(IMAGE_SEARCH_PHRASE_PREFIX));
}

// Raw base64 for eBay's searchByImage request body — lib/ebay-finder.ts's searchEbayByImage
// wants the bare base64 string, not Gemini's {inlineData:{...}} wrapper, so this just unwraps
// referenceImagePart's result rather than duplicating the storage-download logic.
export async function referenceImageBase64(storagePath: string): Promise<string> {
  const part = await referenceImagePart(MATE_GOURD_REFERENCE_IMAGE_BUCKET, storagePath);
  return part.inlineData.data;
}

export type MateGourdMatchResult = {
  matches: boolean;
  confidence: number;
  // 1-based index into the referenceImages array passed in, or null when not confidently one
  // specific reference.
  matchedReferenceIndex: number | null;
  notes: string;
};

// Mirrors lib/gaucho-knife-finder.ts's gauchoMatchConfidenceThreshold — kept as its own env var
// (rather than reusing that one, or GEMINI_CONFIDENCE_THRESHOLD) since this is a different, purely
// open-ended image-similarity judgment worth tuning independently of either.
export function mateGourdMatchConfidenceThreshold() {
  return Number(process.env.GEMINI_MATE_GOURD_CONFIDENCE_THRESHOLD || 0.9);
}

const MATE_GOURD_MAX_REFERENCE_IMAGES = 5;

// One Gemini call, not one per reference image — see lib/gaucho-knife-finder.ts's
// analyzeGauchoKnifeMatch for why this composes into a single generateContent request instead.
export async function analyzeMateGourdMatch(input: { title: string; description: string; candidateImageUrl: string; referenceImages: { storagePath: string }[] }): Promise<MateGourdMatchResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  const references = input.referenceImages.slice(0, MATE_GOURD_MAX_REFERENCE_IMAGES);
  if (!references.length) throw new Error("No reference images are configured for the maté-gourd finder.");
  await reserveUsage();
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const prompt = `Compare the LAST photo (the candidate, from an eBay listing) against the ${references.length} reference photo(s) that come before it, numbered 1 through ${references.length} in order. The reference photos show one SPECIFIC maté gourd — a hollowed calabash/güira gourd cup used for drinking yerba mate, typically finished with a silver or alpaca (nickel-silver) rim/band ("virola") and sometimes a matching base or full metal overlay ("virolado"). Sellers routinely list these with generic wording ("mate cup," "gourd cup," "yerba mate gourd," "Argentine mate"), so judge purely by the candidate's visual gourd shape and size, its wood-grain/shell surface pattern, and the specific design of any silver/metalwork against the references — ignore generic listing wording except for any maker name or hallmark it mentions. A silver-rimmed gourd cup alone is NOT enough to call it a match — that broad shape is shared by countless unrelated maté gourds with different proportions, engraving, and metalwork designs; the candidate's specific shape and metal design must actually match one of the references, not merely "some kind of silver-rimmed mate gourd." Also rule out lookalikes: a modern printed/painted tourist-souvenir gourd with an unrelated silver pattern, a ceramic/porcelain "mate cup" that isn't a real gourd, a mate cup whose metalwork isn't shown clearly enough to compare, a plain coffee/tea mug marketed loosely as a "mate cup," or a bombilla (drinking straw) sold on its own with no cup — set matches to false for any of these even if the listing title uses mate/gourd wording. Set matches to true only when the candidate's specific gourd shape, size, and metalwork pattern plausibly match one of the references — not merely "the same general kind of mate gourd." If matches is true and the candidate most resembles one specific reference photo, set matchedReferenceIndex to that photo's number (1-based); otherwise leave it unset. Explain your reasoning briefly in notes, especially if uncertain, and note explicitly if you ruled out one of the lookalike categories above. Title: ${input.title.slice(0, 300)}. Description: ${input.description.slice(0, 1200)}.`;
  const referenceParts = await Promise.all(references.map((reference) => referenceImagePart(MATE_GOURD_REFERENCE_IMAGE_BUCKET, reference.storagePath)));
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
  const parsed = JSON.parse(text) as Partial<MateGourdMatchResult>;
  if (typeof parsed.matches !== "boolean" || typeof parsed.confidence !== "number" || typeof parsed.notes !== "string") {
    throw new Error("Gemini returned an invalid maté-gourd match analysis.");
  }
  return {
    matches: parsed.matches,
    confidence: parsed.confidence,
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
    // nothing downstream compares these against a ceiling the way pocket-knife/carving-set do.
    total_cost: totalCost,
    cost_per_knife: totalCost,
  };
}

export type MateGourdExistingRow = {
  status: string;
  reason: string | null;
  detection_source: string | null;
  confidence: number | string | null;
  mate_gourd_match_confidence: number | string | null;
  mate_gourd_matched_reference_id: string | null;
  mate_gourd_match_notes: string | null;
  shipping_cost: number | string | null;
  shipping_source: string | null;
};

// No text-only fast path exists for this category — a maté-gourd match is inherently a visual
// judgment, not something resolvable from title/description text alone. Every surviving candidate
// goes straight to "pending" and always takes the vision path on its first tick.
export function initialMateGourdRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, negativePhrases: string[]) {
  const base = baseRow(item, keywordPhrases, runId);
  const categoryFields = { item_category: "mate_gourd" as const, knife_count: 1 as const, contains_folding_knife: false as const };
  if (item.currency !== "USD") return { ...base, ...categoryFields, status: "rejected", reason: "non_usd_currency", processed_at: new Date().toISOString() };
  if (item.shippingCost != null && item.shippingCurrency !== "USD") return { ...base, ...categoryFields, status: "rejected", reason: "non_usd_shipping", processed_at: new Date().toISOString() };
  if (!Number.isFinite(item.itemPrice) || item.itemPrice < 0) return { ...base, ...categoryFields, status: "rejected", reason: "invalid_price", processed_at: new Date().toISOString() };
  if (item.itemEndDate && new Date(item.itemEndDate).getTime() <= Date.now()) return { ...base, ...categoryFields, status: "rejected", reason: "ended", processed_at: new Date().toISOString() };
  const negativeMatch = matchesNegativeKeyword(item.title, item.shortDescription, negativePhrases);
  if (negativeMatch) return { ...base, ...categoryFields, status: "rejected", reason: "negative_keyword_match", mate_gourd_match_notes: `Matched negative keyword: "${negativeMatch}"`, processed_at: new Date().toISOString() };
  if (!item.imageUrl) return { ...base, ...categoryFields, status: "rejected", reason: "missing_image", processed_at: new Date().toISOString() };
  return { ...base, ...categoryFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
}

export function refreshedMateGourdRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, existing: MateGourdExistingRow | undefined, negativePhrases: string[]) {
  const preservedShipping = existing?.shipping_source === "lookup" && existing.shipping_cost != null;
  const effectiveItem = item.shippingCost == null && preservedShipping
    ? { ...item, shippingCost: Number(existing!.shipping_cost), shippingCurrency: "USD" }
    : item;
  const fresh = initialMateGourdRow(effectiveItem, keywordPhrases, runId, negativePhrases);
  const freshRow = preservedShipping ? { ...fresh, shipping_source: "lookup" as const } : fresh;
  // Only reuse a previous vision verdict when today's negative-keyword/validation re-check still
  // leaves the row pending — a fresh rejection always wins (e.g. a newly added negative keyword),
  // same self-correcting behavior the other categories rely on. This is what avoids re-spending a
  // Gemini call on a listing already vision-checked on an earlier scan.
  if (!existing || existing.detection_source !== "vision" || freshRow.status !== "pending") return freshRow;
  return {
    ...freshRow,
    status: existing.status === "qualified" ? "qualified" as const : "rejected" as const,
    reason: existing.reason,
    detection_source: "vision" as const,
    confidence: existing.confidence,
    mate_gourd_match_confidence: existing.mate_gourd_match_confidence,
    mate_gourd_matched_reference_id: existing.mate_gourd_matched_reference_id,
    mate_gourd_match_notes: existing.mate_gourd_match_notes,
    next_attempt_at: null,
    processed_at: new Date().toISOString(),
  };
}
