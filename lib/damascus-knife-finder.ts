// A deliberately separate pipeline from lib/finder-core.ts's pocket-knife pipeline, built on the
// same model: count the knives in one purchase (regex text parsing first, Gemini vision only for
// genuinely ambiguous listings, for cost control), then qualify on cost per knife. It targets
// Damascus-steel pocket knives, bowie knives, and kitchen/chef knives, and differs from the
// pocket-knife pipeline in three ways:
//   1. A listing must actually be Damascus (and not "Damascus-style"/etched/printed imitation).
//   2. Two price tiers instead of one: kitchen/chef knives get their own, higher per-knife ceiling
//      (default $6), every other knife gets the standard ceiling (default $3). A mixed lot
//      qualifies when its total cost fits the sum of each knife's own ceiling.
//   3. Sets and lots are prioritized: they're flagged (damascus_is_set), processed first in the
//      pending queue, listed first on the dashboard, and listed first in alert emails.
// The pocket-knife text patterns, count logic, and vision schema are left untouched.
import { imagePart, reserveUsage, VisionBudgetError, VisionQuotaError } from "./gemini-vision";
import { matchesNegativeKeyword } from "./finder-core";
import type { EbayFinderItem } from "./ebay-finder";

export { VisionBudgetError, VisionQuotaError };

// Must match the phrases seeded by supabase/migrations/047_finder_damascus_knives.sql. Set/lot
// phrases come first and outnumber the single-knife phrases on purpose — see "prioritized" above.
export const DAMASCUS_KNIFE_PHRASES = [
  "damascus knife set", "damascus knife lot", "damascus kitchen knife set", "damascus chef knife set",
  "damascus steak knife set", "damascus pocket knife lot", "damascus pocket knife set", "damascus bowie knife lot",
  "damascus bowie knife set", "damascus pocket knife", "damascus bowie knife", "damascus chef knife",
  "damascus kitchen knife",
];

// Any finder_keywords phrase mentioning "damascus" belongs to this pipeline — not just the seeded
// list above — so staff can add new Damascus search terms from /staff/finder/damascus-knives/settings
// without a code change. lib/finder-service.ts's keywordCategory checks carving-set/gaucho/maté-gourd
// first, so this never steals one of their phrases.
export function damascusKnifeGroupForPhrases(phrases: string[]): boolean {
  return phrases.some((phrase) => /\bdamascus\b/i.test(phrase));
}

export type DamascusSettings = { maxCostPerKnife: number; kitchenMaxCostPerKnife: number };
export const DAMASCUS_DEFAULTS: DamascusSettings = { maxCostPerKnife: 3, kitchenMaxCostPerKnife: 6 };
// Higher than the pocket-knife pipeline's 50: Damascus bulk lots of 60-100 knives are common and real
// (e.g. "Lot of 100 pcs Handmade Damascus Skinner Knife").
export const DAMASCUS_MAX_PLAUSIBLE_KNIFE_COUNT = 200;
export const DAMASCUS_STATED_COUNT_CONFIDENCE = 0.75;

// Damascus results must be physically located in the US — no overseas imports. Enforced twice:
// every Damascus eBay search filters on itemLocationCountry (lib/ebay-finder.ts's
// searchEbayKeyword), and initialDamascusRow rejects any item whose reported location isn't the US
// (covers rows discovered before the filter existed, and anything the eBay filter lets slip).
export const DAMASCUS_ITEM_LOCATION_COUNTRY = "US";

export type DamascusKnifeType = "pocket" | "bowie" | "kitchen" | "fixed_blade" | "mixed";

// The whole listing's budget: each kitchen/chef knife at the kitchen ceiling, every other knife at
// the standard ceiling.
export function damascusCeiling(knifeCount: number, kitchenCount: number, settings: DamascusSettings) {
  const kitchen = Math.min(Math.max(0, kitchenCount), knifeCount);
  return Math.round(((knifeCount - kitchen) * settings.maxCostPerKnife + kitchen * settings.kitchenMaxCostPerKnife) * 100) / 100;
}

export function calculateDamascusDeal(itemPrice: number, shippingCost: number | null, knifeCount: number, kitchenCount: number, settings: DamascusSettings) {
  if (!Number.isFinite(itemPrice) || itemPrice < 0) return { qualifies: false, reason: "invalid_price" as const };
  if (shippingCost == null || !Number.isFinite(shippingCost) || shippingCost < 0) return { qualifies: false, reason: "missing_shipping" as const };
  if (!Number.isInteger(knifeCount) || knifeCount < 1) return { qualifies: false, reason: "invalid_count" as const };
  const totalCost = Math.round((itemPrice + shippingCost) * 100) / 100;
  const ceiling = damascusCeiling(knifeCount, kitchenCount, settings);
  const qualifies = totalCost <= ceiling;
  return { qualifies, reason: qualifies ? null : "over_budget" as const, totalCost, costPerKnife: Math.round((totalCost / knifeCount) * 100) / 100, ceiling };
}

// Shipping only adds cost — same shortcut as the pocket-knife pipeline's isShippingLookupWorthwhile.
export function isDamascusShippingLookupWorthwhile(itemPrice: number, knifeCount: number, kitchenCount: number, settings: DamascusSettings) {
  return Number.isFinite(itemPrice) && knifeCount > 0 && itemPrice <= damascusCeiling(knifeCount, kitchenCount, settings);
}

const damascusPattern = /\bdamascus\b/i;
// Imitation Damascus: a printed/etched/laser pattern on plain steel. "Damascus pattern" alone is
// deliberately NOT here — genuine pattern-welded blades are routinely described that way.
const fakeDamascusPattern = /\b(?:faux|fake|imitation|simulated)\s+damascus\b|\bdamascus[\s-]*(?:style|look|effect|print(?:ed)?|etch(?:ed|ing)?|coat(?:ed|ing)?)\b|\b(?:laser|acid)[\s-]*(?:etch(?:ed|ing)?|engraved)\b/i;
const knifeMakingPattern = /\bbillets?\b|\bblanks?\b|\bbar\s*stock\b|\bknife[\s-]*making\b|\bhandle\s+scales\b|\bscales\s+only\b|\bsheath\s+only\b|\bblade\s+only\b|\bblades?\s+for\s+(?:knife|making)\b/i;
// Damascus steel is common on non-knife items too (swords, axes, rings, shotgun barrels).
const notKnifePattern = /\b(?:swords?|katana|wakizashi|machetes?|axes?|hatchets?|tomahawks?|spears?|straight\s*razors?|shotguns?|barrels?)\b/i;
const knifeWordPattern = /\bkn(?:ife|ives|ifes)\b|\b(?:pocketknife|penknife|jackknife|santoku|nakiri|gyuto|kiritsuke|cleavers?|daggers?|karambits?|bowie|folder|skinners?|tanto)\b/i;
const throwingKnifePattern = /\bthrow(?:ing|er)?s?\s*kn(?:ife|ives|ifes)\b|\bkn(?:ife|ives|ifes)\s+throw(?:ing|ers?)?\b/i;
const keychainKnifePattern = /\bkey[\s-]*(?:chain|ring)\b(?:\s+\w+){0,4}\s*kn(?:ife|ives|ifes)\b|\bkn(?:ife|ives|ifes)\b(?:\s+\w+){0,4}\s*\bkey[\s-]*(?:chain|ring)\b/i;
// Listing wording that says the item ships from abroad even when eBay's location field says US
// (e.g. a US "warehouse" listing that actually drop-ships from overseas).
const shipsFromAbroadPattern = /\b(?:ships?|shipped|shipping|dispatched)\s+(?:directly\s+)?from\s+(?:pakistan|china|india|hong\s*kong|overseas|abroad)\b|\b(?:international|overseas)\s+(?:seller|shipment)\b|\bimported\s+from\b/i;
const selectionPattern = /\b(?:choose|pick|select)\s+(?:your\s+)?(?:one|1|a|any\s+one)\b|\byour\s+choice\b|\bchoice\s+of\b/i;
// "Buyer chooses an option" wording, where the listed price is only one option's (usually the
// cheapest, e.g. a single knife) rather than the whole set in the title. Found in real Damascus
// results: "1-6PCS ... Knives" / "1PC/3PCS/4PCS/6PCS (you can choose)". Deliberately phrase-anchored:
// sellers' "IDEAL GIFT CHOICE" boilerplate must not trigger it.
const optionSelectionPattern = new RegExp([
  // A range or list of piece counts: "1-6PCS", "1PC/3PCS/6PCS", "2 or 3 pcs", "1 to 5 pieces".
  "\\b\\d{1,2}\\s*(?:pcs?|pieces?)?\\s*(?:-|/|\\bor\\b|\\bto\\b)\\s*\\d{1,2}\\s*(?:pcs?|pieces?)\\b",
  "\\byou\\s+(?:can|may|will|need\\s+to|have\\s+to|must)\\s+(?:choose|select|pick)\\b",
  "\\b(?:please|kindly)\\s+(?:choose|select|pick)\\b",
  "\\b(?:choose|select|pick)\\s+(?:from|the|your)\\s+(?:\\w+\\s+){0,2}(?:options?|variations?|drop[\\s-]*down|menu|quantity|qty|size|sets?|models?|styles?|colou?rs?|pieces?|knife|knives)\\b",
  "\\b(?:options?|variations?)\\s+(?:are\\s+)?available\\b",
  "\\bprice\\s+(?:is\\s+|shown\\s+)?(?:for|per)\\s+(?:one|1|a\\s+single|single|each|the\\s+first)\\b",
  "\\bprice\\s+(?:is\\s+)?per\\s+(?:piece|pc|knife|item|unit)\\b",
  "\\bsold\\s+(?:individually|separately|each|per\\s+piece)\\b",
].join("|"), "i");

const kitchenPattern = /\b(?:chef'?s?|kitchen|cooking|santoku|nakiri|gyuto|kiritsuke|cleavers?|paring|bread\s+kn|boning|fill?ets?|carving\s+kn|slic(?:er|ing)|steak\s+kn|petty|bunka|deba|yanagiba|sujihiki|usuba|cutlery|kni(?:fe|ves)\s+block)\b/i;
const pocketPattern = /\b(?:pocket\s*kn(?:ife|ives|ifes)|pocketknife|pen\s*kn(?:ife|ives)|penknife|jack\s*kn(?:ife|ives)|jackknife|folding|foldable|folders?|flipper|liner\s*lock|lock\s*back|back\s*lock|frame\s*lock)\b/i;
const bowiePattern = /\bbowie\b/i;
const fixedBladePattern = /\b(?:hunting|hunter|skinn(?:er|ing)|fixed[\s-]*blade|daggers?|tanto|karambits?|bushcraft|survival|tactical|outdoor|camping|utility)\b/i;

// Words that make a listing a set/lot — the thing this finder prioritizes.
const setPattern = /\b(?:sets?|lots?|bundle|collection|pcs?|pieces?|pair|kits?)\b/i;
const pluralKnifePattern = /\bkn(?:ives|ifes)\b/i;
// A "N-piece kitchen set" often counts a block, scissors, or a sharpening steel among the pieces,
// so a piece count is only trusted as a knife count when none of these are mentioned.
// Sheaths, pouches, cases, and boxes are deliberately absent: they ship one per knife and sellers
// don't count them as pieces ("Lot of 20 pcs Skinner Knife with Sheath" is 20 knives). Including
// them sent every sheathed lot to Gemini, where a sample photo got it wrongly rejected.
const setAccessoryPattern = /\b(?:block|stand|holder|scissors|shears|sharpener|sharpening|honing|whetstone|stone|roll|bag|magnetic|peeler|forks?)\b/i;

const numberWords: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, dozen: 12, fifteen: 15, twenty: 20, pair: 2,
};

function clean(text: string) { return text.replace(/\s+/g, " ").trim(); }

// Returns { count, fromPieces } — fromPieces marks a count read from "N pc"/"set of N" wording
// rather than "N knives", so the caller can distrust it when accessories are mentioned.
function damascusKnifeCount(title: string, description: string): { count: number; fromPieces: boolean } | null {
  const cleanTitle = clean(title);
  const cleanDescription = clean(description);
  // The lookbehind excludes steel/model codes like "VG-10" or "AUS-8"; "67 layer" never matches
  // because the number has to sit right before the knife word (up to three qualifiers between).
  const componentPattern = /(?<![A-Za-z]-)\b(\d{1,3})\s*(?:(?:damascus|steel|pocket|folding|kitchen|chef'?s?|bowie|hunting|fixed[ -]blade|steak|handmade|custom|japanese|vintage)\s+){0,3}kn(?:ife|ives|ifes)\b/gi;
  const values = (text: string) => [...new Set([...text.matchAll(componentPattern)].map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
  const titleValues = values(cleanTitle);
  if (titleValues.length > 1) return { count: titleValues.reduce((sum, value) => sum + value, 0), fromPieces: false };
  if (titleValues.length === 1) return { count: titleValues[0], fromPieces: false };
  // "Lot of N" states a knife quantity, not a piece count, so it's trusted even when accessories
  // are mentioned; "set of N"/"N pcs" can include a block or sharpener among the pieces.
  const lotValue = Number(cleanTitle.match(/\blot\s+of\s+(\d{1,3})\b/i)?.[1]);
  if (Number.isInteger(lotValue) && lotValue > 0) return { count: lotValue, fromPieces: false };
  const pieceCountPatterns = [
    /\bset\s+of\s+(\d{1,3})\b/i,
    /(?<![A-Za-z]-)\b(\d{1,3})[\s-]*(?:pcs?|pieces?|pk|pack)\b/i,
  ];
  for (const pattern of pieceCountPatterns) {
    const value = Number(cleanTitle.match(pattern)?.[1]);
    if (Number.isInteger(value) && value > 0) return { count: value, fromPieces: true };
  }
  const words = Object.keys(numberWords).join("|");
  const wordPattern = new RegExp(`\\b(?:(?:lot|set)\\s+of\\s+)?(${words})\\s+(?:(?:damascus|steel|pocket|folding|kitchen|chef'?s?|bowie)\\s+){0,3}kn(?:ife|ives|ifes)\\b`, "i");
  const wordMatch = cleanTitle.match(wordPattern);
  if (wordMatch) return { count: numberWords[wordMatch[1].toLowerCase()], fromPieces: false };
  const descriptionValues = values(cleanDescription);
  if (descriptionValues.length === 1) return { count: descriptionValues[0], fromPieces: false };
  return null;
}

export type DamascusTextAnalysis =
  | { kind: "reject"; reason: string }
  | { kind: "resolved"; count: number; kitchenCount: number; knifeType: DamascusKnifeType; isSet: boolean; confidence: number }
  | { kind: "vision"; knownCount?: number; maxCount?: number; isSet: boolean };

export function analyzeDamascusText(title: string, description = ""): DamascusTextAnalysis {
  const text = clean(`${title} ${description}`);
  if (selectionPattern.test(text) || optionSelectionPattern.test(text)) return { kind: "reject", reason: "selection_listing" };
  if (!damascusPattern.test(text)) return { kind: "reject", reason: "not_damascus" };
  if (shipsFromAbroadPattern.test(text)) return { kind: "reject", reason: "not_us_located" };
  if (fakeDamascusPattern.test(text)) return { kind: "reject", reason: "fake_damascus" };
  if (knifeMakingPattern.test(text)) return { kind: "reject", reason: "knife_making_supplies" };
  if (notKnifePattern.test(title)) return { kind: "reject", reason: "not_a_knife" };
  if (!knifeWordPattern.test(text)) return { kind: "reject", reason: "not_a_knife" };
  if (throwingKnifePattern.test(text)) return { kind: "reject", reason: "throwing_knife" };
  if (keychainKnifePattern.test(text)) return { kind: "reject", reason: "keychain_knife" };

  // Type is read from the title only — descriptions are often generic shop boilerplate listing
  // every product line the seller carries.
  const kitchen = kitchenPattern.test(title);
  const nonKitchenFamilies = [pocketPattern.test(title) && "pocket", bowiePattern.test(title) && "bowie", fixedBladePattern.test(title) && "fixed_blade"].filter(Boolean) as DamascusKnifeType[];
  const counted = damascusKnifeCount(title, description);
  // A kitchen set's "N pcs" is never a knife count: these sets routinely count a roll bag, sheaths,
  // a sharpener, or scissors among the pieces without saying so anywhere in the listing ("14PCS
  // chef knife set" turned out to be 7 knives and 7 accessories). The piece count is kept only as
  // an upper bound (maxCount) and the knives are counted from the photo.
  const kitchenPieces = Boolean(counted?.fromPieces && kitchen);
  const piecesUntrusted = counted?.fromPieces && (kitchenPieces || setAccessoryPattern.test(text));
  const count = counted && !piecesUntrusted && counted.count <= DAMASCUS_MAX_PLAUSIBLE_KNIFE_COUNT ? counted.count : null;
  const maxCount = kitchenPieces && counted!.count <= DAMASCUS_MAX_PLAUSIBLE_KNIFE_COUNT ? counted!.count : undefined;
  const isSet = setPattern.test(title) || pluralKnifePattern.test(title) || (counted?.count ?? 0) > 1;

  // A kitchen set that also includes a pocket/bowie knife needs vision to split the two tiers.
  const typeKnown = kitchen ? nonKitchenFamilies.length === 0 : nonKitchenFamilies.length > 0;
  if (typeKnown) {
    const knifeType: DamascusKnifeType = kitchen ? "kitchen" : nonKitchenFamilies.length === 1 ? nonKitchenFamilies[0] : "mixed";
    if (count) return { kind: "resolved", count, kitchenCount: kitchen ? count : 0, knifeType, isSet: isSet || count > 1, confidence: 0.99 };
    if (!isSet) return { kind: "resolved", count: 1, kitchenCount: kitchen ? 1 : 0, knifeType, isSet: false, confidence: 0.95 };
  }
  return { kind: "vision", ...(count ? { knownCount: count } : {}), ...(maxCount ? { maxCount } : {}), isSet };
}

export const DAMASCUS_VISION_KNIFE_TYPES = ["pocket", "bowie", "kitchen", "fixed_blade", "mixed", "not_a_knife"] as const;
export type DamascusVisionKnifeType = typeof DAMASCUS_VISION_KNIFE_TYPES[number];

export type DamascusVisionResult = {
  knifeCount: number;
  kitchenKnifeCount: number;
  knifeType: DamascusVisionKnifeType;
  isSet: boolean;
  bladeLooksNonDamascus: boolean;
  confidence: number;
  notes: string;
};

// Same Gemini model, budget reservation, and image plumbing as the pocket-knife pipeline's
// countKnivesWithGemini, with a Damascus-specific prompt/schema: it additionally splits out how many
// of the knives are kitchen/chef knives (the higher price tier) and flags a visibly plain,
// non-Damascus blade.
export async function analyzeDamascusWithGemini(input: { title: string; description: string; imageUrl: string }): Promise<DamascusVisionResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  await reserveUsage();
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const prompt = `Analyze this eBay listing for a buyer of Damascus-steel knives (pocket/folding knives, bowie knives, and kitchen/chef knives). Count every physical knife included in one purchase. Do not count cases, sheaths, knife blocks, scissors, sharpening steels, forks, or repeated views of the same knife. Separately count how many of those knives are kitchen/culinary knives (chef, santoku, nakiri, paring, bread, boning, fillet, slicing, carving, steak, cleaver, utility kitchen knives); pocket/folding, bowie, hunting, and other fixed-blade knives are NOT kitchen knives. Set knifeType to pocket, bowie, kitchen, or fixed_blade when every knife is that kind, mixed when the lot combines kinds, or not_a_knife when the item is not a knife at all (a sword, axe, blank/billet, ring, jewelry, sheath only, etc.). Set isSet to true when the purchase is a matched set or a multi-knife lot. Damascus steel shows a visible wavy/layered pattern across the blade; set bladeLooksNonDamascus to true ONLY if a blade is clearly visible and plainly shows no such pattern (plain polished, satin, or painted steel) — a closed folding knife or a blade hidden in a block/sheath is not evidence either way, so leave it false then. If the title or description states the quantity (e.g. "Lot of 60", "5 pcs"), use that stated quantity as knifeCount and do NOT lower confidence just because the photo shows only one or a few sample knives — sellers of bulk lots routinely photograph a sample; confidence should then reflect whether these are Damascus knives of the kind described. Lower confidence (and explain why in notes) only if this is a choose-one/selection listing, the image is too unclear to tell what the knives are, or no quantity is stated and the included count can't be established from the photo. Title: ${input.title.slice(0, 300)}. Description: ${input.description.slice(0, 1200)}.`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, await imagePart(input.imageUrl)] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 300,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: ["knifeCount", "kitchenKnifeCount", "knifeType", "isSet", "bladeLooksNonDamascus", "confidence", "notes"],
          properties: {
            knifeCount: { type: "INTEGER", minimum: 0 },
            kitchenKnifeCount: { type: "INTEGER", minimum: 0 },
            knifeType: { type: "STRING", enum: DAMASCUS_VISION_KNIFE_TYPES },
            isSet: { type: "BOOLEAN" },
            bladeLooksNonDamascus: { type: "BOOLEAN" },
            confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
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
  const parsed = JSON.parse(text) as Partial<DamascusVisionResult>;
  if (
    !Number.isInteger(parsed.knifeCount) ||
    !Number.isInteger(parsed.kitchenKnifeCount) ||
    typeof parsed.knifeType !== "string" || !(DAMASCUS_VISION_KNIFE_TYPES as readonly string[]).includes(parsed.knifeType) ||
    typeof parsed.isSet !== "boolean" ||
    typeof parsed.bladeLooksNonDamascus !== "boolean" ||
    typeof parsed.confidence !== "number" ||
    typeof parsed.notes !== "string"
  ) throw new Error("Gemini returned an invalid Damascus knife analysis.");
  return parsed as DamascusVisionResult;
}

// Turns a vision result into a count/tier split, or a rejection reason. A title-stated count (text's
// knownCount) wins over vision's own count, same as the pocket-knife pipeline — vision is prone to
// counting a seller's whole stock photo.
export function evaluateDamascusVision(vision: DamascusVisionResult, knownCount: number | undefined, confidenceThreshold: number): { reason: string | null; knifeCount: number; kitchenCount: number; knifeType: DamascusKnifeType | null; isSet: boolean } {
  const knifeCount = knownCount ?? vision.knifeCount;
  // When the title states the quantity, the count doesn't come from the photo — a photo showing only
  // a sample of a "Lot of 60" is normal and shouldn't sink the listing, so a lower bar applies to
  // what vision still decides (is it a Damascus knife, and which kind).
  const threshold = knownCount != null ? Math.min(confidenceThreshold, DAMASCUS_STATED_COUNT_CONFIDENCE) : confidenceThreshold;
  const kitchenCount = vision.knifeType === "kitchen" ? knifeCount : Math.min(vision.kitchenKnifeCount, knifeCount);
  const knifeType = vision.knifeType === "not_a_knife" ? null : vision.knifeType;
  const isSet = vision.isSet || knifeCount > 1;
  const reason = vision.knifeType === "not_a_knife" ? "not_a_knife"
    : vision.bladeLooksNonDamascus ? "not_damascus_vision"
    : vision.confidence < threshold ? "low_confidence"
    : knifeCount < 1 ? "invalid_count"
    : knifeCount > DAMASCUS_MAX_PLAUSIBLE_KNIFE_COUNT ? "implausible_count"
    : null;
  return { reason, knifeCount, kitchenCount, knifeType, isSet };
}

function baseRow(item: EbayFinderItem, keywordPhrases: string[], runId: string) {
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
    // Set unconditionally on every row this pipeline writes, so lib/finder-service.ts's
    // scopeToCategory can scope by item_category (a phrase "contains damascus" test can't be
    // expressed as a Postgres array operator).
    item_category: "damascus_knife" as const,
  };
}

// eBay's Browse API item id is "v1|<listing id>|<variation id>"; a non-zero variation id means a
// multi-variation listing, whose search-result price is only the matched variation's (typically
// the cheapest option, e.g. one knife out of a "1-6PCS" listing) — never the set in the title.
export function isVariationListing(itemId: string) {
  const variationId = itemId.split("|")[2];
  return Boolean(variationId) && variationId !== "0";
}

export type DamascusExistingRow = {
  status?: string;
  short_description?: string | null;
  damascus_description_checked?: boolean | null;
  reason?: string | null;
  knife_count: number | null;
  confidence: number | null;
  detection_source: string | null;
  shipping_cost: number | string | null;
  shipping_source: string | null;
  damascus_knife_type?: DamascusKnifeType | null;
  damascus_kitchen_count?: number | null;
  damascus_is_set?: boolean | null;
  damascus_notes?: string | null;
};

// descriptionChecked: whether the listing's full eBay description (not just the search snippet) has
// already been read. A listing is never qualified on the snippet alone — sellers put "choose an
// option" wording and "set includes a roll bag and sharpener" piece counts in the full description —
// so a would-be qualifier stays pending until lib/finder-service.ts's processDamascusRow fetches the
// full description and re-checks it (one eBay call, spent only on listings about to qualify).
function pricedRow<T extends object>(row: T, item: EbayFinderItem, count: number, kitchenCount: number, settings: DamascusSettings, descriptionChecked = false) {
  if (item.shippingCost == null) {
    if (!isDamascusShippingLookupWorthwhile(item.itemPrice, count, kitchenCount, settings)) {
      return { ...row, status: "rejected", reason: "over_budget", processed_at: new Date().toISOString() };
    }
    return { ...row, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
  }
  const deal = calculateDamascusDeal(item.itemPrice, item.shippingCost, count, kitchenCount, settings);
  if (deal.qualifies && !descriptionChecked) {
    return { ...row, status: "pending", reason: null, total_cost: deal.totalCost, cost_per_knife: deal.costPerKnife, next_attempt_at: new Date().toISOString() };
  }
  return {
    ...row,
    status: deal.qualifies ? "qualified" : "rejected",
    reason: deal.reason,
    total_cost: "totalCost" in deal ? deal.totalCost : null,
    cost_per_knife: "costPerKnife" in deal ? deal.costPerKnife : null,
    processed_at: new Date().toISOString(),
  };
}

export function initialDamascusRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, settings: DamascusSettings, negativePhrases: string[], descriptionChecked = false) {
  const base = baseRow(item, keywordPhrases, runId);
  const rejected = (reason: string, extra: Record<string, unknown> = {}) => ({ ...base, ...extra, status: "rejected", reason, processed_at: new Date().toISOString() });
  if (item.currency !== "USD") return rejected("non_usd_currency");
  if (item.shippingCost != null && item.shippingCurrency !== "USD") return rejected("non_usd_shipping");
  if (!Number.isFinite(item.itemPrice) || item.itemPrice < 0) return rejected("invalid_price");
  if (item.itemEndDate && new Date(item.itemEndDate).getTime() <= Date.now()) return rejected("ended");
  if (item.itemLocationCountry && item.itemLocationCountry.toUpperCase() !== DAMASCUS_ITEM_LOCATION_COUNTRY) return rejected("not_us_located", { damascus_notes: `Item located in ${item.itemLocationCountry}` });
  if (isVariationListing(item.itemId) || item.itemGroupType) return rejected("variation_listing", { damascus_notes: "Multi-variation listing: the price shown is only one option's, not the whole set." });
  const negativeMatch = matchesNegativeKeyword(item.title, item.shortDescription, negativePhrases);
  if (negativeMatch) return rejected("negative_keyword_match", { damascus_notes: `Matched negative keyword: "${negativeMatch}"` });
  const text = analyzeDamascusText(item.title, item.shortDescription);
  if (text.kind === "reject") return rejected(text.reason);
  if (text.kind === "resolved") {
    const known = { ...base, knife_count: text.count, contains_folding_knife: text.knifeType === "pocket", confidence: text.confidence, detection_source: "text" as const, damascus_knife_type: text.knifeType, damascus_kitchen_count: text.kitchenCount, damascus_is_set: text.isSet };
    return pricedRow({ ...known, damascus_description_checked: descriptionChecked }, item, text.count, text.kitchenCount, settings, descriptionChecked);
  }
  // Even if every piece were a knife the set couldn't qualify — no photo count can change that.
  if (text.maxCount && Number(item.itemPrice) + Number(item.shippingCost ?? 0) > damascusCeiling(text.maxCount, text.maxCount, settings)) {
    return rejected("over_budget", { damascus_is_set: text.isSet, damascus_notes: `Over budget even if all ${text.maxCount} pieces were knives.` });
  }
  if (!item.imageUrl) return rejected("missing_image", { damascus_is_set: text.isSet });
  // Counts are cleared explicitly so a rescan of a row an earlier rule had text-counted doesn't keep
  // that stale count (an upsert leaves columns it doesn't mention untouched).
  return { ...base, knife_count: null, detection_source: null, confidence: null, damascus_is_set: text.isSet, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
}

export function refreshedDamascusRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, existing: DamascusExistingRow | undefined, settings: DamascusSettings, negativePhrases: string[]) {
  // Reuse a per-item shipping lookup across refreshes rather than re-spending an eBay call.
  const preservedShipping = existing?.shipping_source === "lookup" && existing.shipping_cost != null;
  const shippedItem = item.shippingCost == null && preservedShipping
    ? { ...item, shippingCost: Number(existing!.shipping_cost), shippingCurrency: "USD" }
    : item;
  // Once the full description has been fetched, keep analyzing against it (and keep it stored)
  // instead of the much shorter search snippet, so a rescan neither re-spends that eBay call nor
  // loses the selection/accessory wording that only the full description contains.
  const descriptionChecked = Boolean(existing?.damascus_description_checked && existing.short_description);
  const effectiveItem = descriptionChecked ? { ...shippedItem, shortDescription: existing!.short_description! } : shippedItem;
  const fresh = initialDamascusRow(effectiveItem, keywordPhrases, runId, settings, negativePhrases, descriptionChecked);
  const freshRow = preservedShipping ? { ...fresh, shipping_source: "lookup" as const } : fresh;
  // Fresh text always wins when it has an opinion (rejected or resolved); only a still-ambiguous
  // listing reuses a previous vision verdict, re-priced against today's price and settings.
  if (freshRow.status !== "pending" || (freshRow as { knife_count?: number | null }).knife_count != null) return freshRow;
  if (!existing || existing.detection_source !== "vision" || existing.knife_count == null) return freshRow;
  const visionFields = {
    ...freshRow,
    knife_count: existing.knife_count,
    confidence: existing.confidence,
    detection_source: "vision" as const,
    damascus_knife_type: existing.damascus_knife_type ?? null,
    damascus_kitchen_count: existing.damascus_kitchen_count ?? 0,
    damascus_is_set: existing.damascus_is_set ?? ("damascus_is_set" in freshRow ? freshRow.damascus_is_set : null),
    damascus_notes: existing.damascus_notes ?? null,
  };
  // A previous vision rejection for what the item *is* (not its price) stays rejected.
  if (existing.status === "rejected" && existing.reason && existing.reason !== "over_budget" && existing.reason !== "missing_shipping") {
    return { ...visionFields, status: "rejected", reason: existing.reason, next_attempt_at: null, processed_at: new Date().toISOString() };
  }
  return { ...pricedRow({ ...visionFields, damascus_description_checked: descriptionChecked }, effectiveItem, existing.knife_count, existing.damascus_kitchen_count ?? 0, settings, descriptionChecked) };
}

// Sets/lots first, then the most knives, then newest — the dashboard's and alert emails' order.
export function compareDamascusPriority(a: { damascus_is_set?: boolean | null; knife_count?: number | null }, b: { damascus_is_set?: boolean | null; knife_count?: number | null }) {
  return Number(Boolean(b.damascus_is_set)) - Number(Boolean(a.damascus_is_set)) || (b.knife_count ?? 0) - (a.knife_count ?? 0);
}
