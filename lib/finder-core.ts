export const FINDER_DEFAULTS = {
  zip: "32819",
  maxCostPerKnife: 3.5,
  confidence: 0.9,
  resultsPerKeyword: 500,
  // Sized so the app's own conservative $0.001/analysis accounting (see finderOverview's
  // projectedMaximum) lands at a $10/month ceiling. This is a hard backstop, not a pacing
  // mechanism — see dailyLimit in gemini-vision.ts/finder-service.ts for what actually spreads
  // usage evenly across the month instead of letting one busy week exhaust it.
  monthlyAnalysisLimit: 10_000,
  // Items pulled off the pending queue per tick, and how many of them (vision + shipping
  // lookups) run concurrently. At the old batchSize of 5 processed one at a time, a queue of a
  // few thousand items (typical after a daily scan) took most of a day to drain at one tick per
  // minute. Concurrency is kept modest to stay well clear of Gemini's per-minute rate limit —
  // hitting it just defers items an hour anyway (see VisionQuotaError handling), so being too
  // aggressive is self-defeating, not merely wasteful.
  batchSize: 40,
  processConcurrency: 8,
  // Keyword searches in startFinderRun's scan phase run with this much concurrency. Scanning
  // 30+ keywords one at a time risked exceeding the API route's serverless time budget before
  // the scan even finished (see the throttled progress-write comment in finder-service.ts).
  scanConcurrency: 6,
  maxPlausibleKnifeCount: 50,
  // Swiss Army multi-tools (a small blade plus other tools) are the one multi-tool style worth
  // buying at all, and only far below the normal per-knife ceiling.
  swissArmyMaxCostPerKnife: 1.0,
} as const;

const numberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, pair: 2,
};

const foldingPattern = /\b(?:folding|foldable|pocket\s*kn(?:ife|ives|ifes)|pen\s*kn(?:ife|ives|ifes)|penknife|jack\s*kn(?:ife|ives|ifes)|jackknife)\b/i;
// Tracked separately from foldingPattern (rather than folded into it, as it used to be) because a
// Swiss Army item needs a distinct, much stricter price cap downstream — see effectiveMaxCostPerKnife.
const swissArmyPattern = /\b(?:swiss\s+army|victorinox|wenger)\b/i;
const knifePattern = /\bkn(?:ife|ives|ifes)\b/i;
const lotPattern = /\b(?:lot|bulk|assorted|collection|group|bundle)\b/i;
// Garbage categories the buyer never wants, checked before any count/folding resolution so they
// can't slip through just because the title also happens to mention "folding"/"pocket knife" or a
// known brand. Anchored to concrete nouns/phrases, not "utility knife" or bare "multi-tool" alone —
// both of those show up in genuinely good listings (a folding utility-style pocket knife; a real
// knife lot that happens to also include one bonus multi-tool).
const boxCutterPattern = /\bbox[\s-]*cutters?\b/i;
const creditCardKnifePattern = /\bcredit[\s-]*cards?\b(?:\s+\w+){0,4}\s*kn(?:ife|ives|ifes)\b|\bcard\s*kn(?:ife|ives|ifes)\b|\bwallet\s*kn(?:ife|ives|ifes)\b/i;
const coinKnifePattern = /\bcoin\b(?:\s+\w+){0,4}\s*kn(?:ife|ives|ifes)\b/i;
const plainBladePattern = /\breplacement\s+blades?\b|\bblade\s+(?:only|blanks?)\b|\bbare\s+blades?\b/i;
// Anchored to the concrete extra-tool words the buyer actually described (a knife combined with a
// corkscrew/bottle-opener), not the bare phrase "multi-tool" — that phrase alone already appears in
// two real, wanted listings in the test corpus (a lot of knives that happens to include one bonus
// multi-tool; a "Knifes And Multitools" mixed lot).
const multiToolPattern = /\bcorkscrew\b|\bbottle[\s-]*opener\b/i;
// Mainstream brands whose flagship consumer lines are folding pocket knives — well known to this
// business already (the same names are seeded as finder_keywords). A count anchored to one of
// these is trusted the same way an explicit "folding"/"pocket knife" mention is, and title-only
// numeric extraction (see numericCount) is allowed to bridge the brand/model name that otherwise
// sits between the digit and the knife word (e.g. "4 Kershaw Knives", "10 Gerber Paraframe Knives").
const brandNames = [
  "buck", "gerber", "kershaw", "leatherman", "schrade", "case", "spyderco", "benchmade", "victorinox",
  "old\\s*timer", "camillus", "boker", "imperial", "winchester", "browning",
  "smith\\s*(?:and|&)\\s*wesson", "s&w", "crkt", "sog", "civivi", "cold\\s*steel",
  "frost(?:\\s+cutlery)?", "m-tech", "ozark\\s*trail", "rough\\s*ry?der", "byrd", "coast",
  "elk\\s*ridge", "opinel", "colt", "mossy\\s*oak", "tac\\s*force", "remington", "zippo",
].join("|");
// digit -> up to 2 filler words -> known brand -> up to 3 filler words -> knife word. The "lot "
// lookbehind keeps this out of the same auction-lot-numbering trap componentPattern below avoids
// (e.g. "Lot 45 folding pocket knife" is a lot number, not a count).
const brandedComponentPattern = new RegExp(`(?<!lot )(?<![A-Za-z]-)\\b(\\d{1,3})\\s+(?:[A-Za-z][\\w.'-]{0,20}\\s+){0,2}?(?:${brandNames})\\b(?:\\s+[A-Za-z][\\w.'-]{0,20}){0,3}?\\s*(?:kn(?:ife|ives|ifes)|fixed\\s+blades?)\\b`, "gi");
const brandKnifePattern = new RegExp(`\\b(?:${brandNames})\\b(?:\\s+[A-Za-z][\\w.'-]{0,20}){0,4}?\\s*kn(?:ife|ives|ifes)\\b`, "i");
const selectionPattern = /\b(?:choose|choice|select)\s+(?:one|1|a)\b|\b(?:each|per\s+knife|sold\s+separately)\b/i;
// Anchored to the title only: a seller stating outright that a "knife" lot holds no knives
// (empty display boxes, manuals-only estate finds) is a far stronger and safer signal than
// scanning the full description, where an aside about one empty accessory (e.g. a sheath) sold
// alongside real knives would otherwise cause a false rejection.
const noKnifePattern = /\bempty\s+(?:\w+\s+){0,2}box(?:es)?\b|\bbox(?:es)?\s+only\b|\bno\s+knives?\b/i;
// Catalog references like "No. 6 & 8" enumerate model numbers, never a count of items.
const catalogReferencePattern = /\bno\.?\s*\d+(?:\s*(?:&|,|and)\s*\d+)+\b/gi;
// Table/kitchen cutlery wording that real listings use to describe non-folding knives (serving
// sets, silverware, butcher/chef knives) — sampled production data shows Gemini vision
// consistently confirming containsFoldingKnife: false for titles like these, which means the
// vision call was spent only to reach a conclusion the wording already stated outright. Gated on
// !explicitFoldingSignal (not the broader foldingSignal — see below) so a listing that actually
// says "folding"/"pocket knife"/Swiss Army (e.g. a folding knife bundled with a butter knife)
// still falls through to the normal resolution path instead of being wrongly rejected, while a
// bare shared brand name (several of which — Case, Winchester, Colt, Remington, Camillus, Old
// Timer, Browning, Imperial — are just as common on vintage kitchen/carving cutlery and flatware
// as on pocket knives) no longer overrides the rejection on its own.
const nonFoldingCutleryPattern = /\b(?:kitchen|steak|butter|bread|cheese|carving|chef'?s?|paring|butcher|flatware|silverware|silverplate|letter\s+opener)\b|\bserv(?:e|ing)\b|\bcutlery\s+set\b/i;
// Weight-priced/randomized "grab bag" style lots (common for TSA-confiscated bulk resellers): the
// buyer receives a random weight-based selection, not a stated piece count, so any number found
// elsewhere in the text (an inventory-pool size, a catalog total) — or a photo of the seller's
// whole pool of stock — does not represent what actually ships. Requires the weight unit to sit
// near the grab-bag/mystery/sold-by-weight wording (not just appear anywhere in the text) so an
// otherwise-resolvable lot that merely mentions an unrelated shipping-box weight isn't caught.
const weightQuantity = "\\d+(?:\\.\\d+)?\\+?\\s*(?:lbs?|pounds?|#|oz|ounces?|kgs?|kilograms?)\\b";
const grabBagPhrase = "(?:grab\\s*bags?|mystery\\s+(?:lot|box|bags?))";
const weightBasedLotPattern = new RegExp(
  `\\b${weightQuantity}(?:\\s+\\w+){0,4}?\\s*${grabBagPhrase}\\b` +
  `|\\b${grabBagPhrase}\\b(?:\\s+\\w+){0,4}?\\s*${weightQuantity}` +
  `|\\bsold\\s+by\\s+the\\s+(?:pound|weight)\\b|\\bpriced?\\s+(?:by|per)\\s+the\\s+(?:pound|weight)\\b`,
  "i",
);

export type TextAnalysis =
  | { kind: "reject"; reason: string }
  | { kind: "resolved"; count: number; containsFoldingKnife: true; confidence: number; swissArmy?: true }
  | { kind: "vision" };

// Patterns that require a knife/blade word directly adjacent to the number are safe to trust
// anywhere in the listing text. Patterns that infer a count from lot/piece phrasing without that
// anchor (auction lot numbering, bundled non-knife items, dimensions, model numbers) are only
// trusted against the short seller-authored title, where they're far less likely to misfire.
//
// The title and description are matched independently, never concatenated into one string, for
// two reasons: (1) it stops a trailing number in the title (a model name) from fusing with a
// leading "knife" word at the start of the description into a false match, and (2) sellers very
// commonly paste the title into the description too, and matching each field once and then
// de-duplicating identical values (rather than summing every match found) keeps that restatement
// from silently doubling the count. Distinct values are still summed, so a genuine mixed lot like
// "10 folding knives and 2 kitchen knives" is unaffected.
function numericCount(title: string, description: string) {
  const stripCatalogReferences = (text: string) => text.replace(catalogReferencePattern, " ");
  const cleanTitle = stripCatalogReferences(title).replace(/\s+/g, " ").trim();
  const cleanDescription = stripCatalogReferences(description).replace(/\s+/g, " ").trim();

  // The lookbehind excludes hyphenated model codes like "FE-024" or "SL-13", where the digits
  // are part of a product name rather than a quantity.
  const componentPattern = /(?<![A-Za-z]-)\b(\d{1,3})\s*(?:(?:folding|pocket|kitchen|fixed[ -]blade)\s+)?(?:kn(?:ife|ives|ifes)|fixed\s+blades?)\b/gi;
  const matchValues = (text: string) => [...text.matchAll(componentPattern)].map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0);
  const components = [...new Set([...matchValues(cleanTitle), ...matchValues(cleanDescription)])];
  if (components.length > 1) return components.reduce((sum, value) => sum + value, 0);

  const explicitPattern = /(?<![A-Za-z]-)\b(\d{1,3})\s*(?:pocket\s+|folding\s+)?kn(?:ife|ives|ifes)\b/i;
  const explicitValue = Number((cleanTitle.match(explicitPattern) ?? cleanDescription.match(explicitPattern))?.[1]);
  if (Number.isInteger(explicitValue) && explicitValue > 0) return explicitValue;
  if (components.length === 1) return components[0];
  // No generic "x123" pattern here: it's indistinguishable from model numbers like "SOG X42"
  // or dimensions like "4 x 90mm" with no reliable anchor, so those are left to Gemini vision.
  const loosePatterns = [
    /\blot\s+of\s+(\d{1,3})\b/i,
    /\b(\d{1,3})[\s-]*(?:pc|pcs|piece|pieces|pk|pack)\b/i,
    // "Pick Any 5 Knives From This Lot of 184" style variation listings: the seller states the
    // real per-purchase count directly, distinct from whatever pool/inventory size is mentioned
    // elsewhere. selectionPattern already hard-rejects the singular "choose one/1/a" phrasing
    // before numericCount ever runs, so this only ever fires on N >= 2 (or "pick 1", not covered
    // by selectionPattern's verb list) — no conflict with that existing behavior.
    /\b(?:choose|pick|select)\s+(?:any\s+)?(\d{1,3})\b/i,
  ];
  for (const pattern of loosePatterns) {
    const match = cleanTitle.match(pattern);
    const value = Number(match?.[1]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  const words = Object.keys(numberWords).join("|");
  const wordPattern = new RegExp(`\\b(?:lot\\s+(?:of\\s+)?)?(${words})\\s+(?:pocket\\s+|folding\\s+)?kn(?:ife|ives|ifes)\\b`, "i");
  const wordMatch = cleanTitle.match(wordPattern) ?? cleanDescription.match(wordPattern);
  if (wordMatch) return numberWords[wordMatch[1].toLowerCase()];

  // Last-resort, title-only, single-value-only fallback: a known brand bridges the gap between a
  // digit and the knife word (e.g. "4 Kershaw Knives"). Reached only when every check above found
  // nothing at all. Title-only and single-value-only on purpose — descriptions are frequently
  // generic/reused boilerplate that can state a different number than this specific listing
  // (confirmed against real listings), and summing multiple branded matches risks double-counting
  // an aggregate-plus-breakdown title (e.g. "3 Knives: 1 Byrd, 2 Coast" is 3 total, not 5).
  const brandedValues = [...new Set([...cleanTitle.matchAll(brandedComponentPattern)].map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
  return brandedValues.length === 1 ? brandedValues[0] : null;
}

// A listing signals "this is a folding pocket knife" either by saying so directly (foldingPattern),
// by naming one of the mainstream brands whose flagship lines are folding knives, or by naming
// Swiss Army/Victorinox/Wenger — the same weight as an explicit "folding"/"pocket knife" mention,
// since it's equally reliable. Swiss Army items are still flagged separately (see analyzeListingText)
// since they need a much stricter price cap downstream, not because they're a weaker signal here.
function foldingSignal(text: string) { return foldingPattern.test(text) || brandKnifePattern.test(text) || swissArmyPattern.test(text); }

// Stricter than foldingSignal: only an explicit "folding"/"pocket knife"/Swiss Army mention
// counts, not a bare shared brand name. Used solely to gate the kitchen-cutlery rejection below —
// several brand names (Case, Winchester, Colt, Remington, Camillus, Old Timer, Browning, Imperial)
// are just as common on vintage kitchen/carving cutlery and flatware as on pocket knives, so
// letting a bare brand match override that rejection let plenty of table cutlery through.
function explicitFoldingSignal(text: string) { return foldingPattern.test(text) || swissArmyPattern.test(text); }

export function analyzeListingText(title: string, description = ""): TextAnalysis {
  const text = `${title} ${description}`.replace(/\s+/g, " ").trim();
  if (selectionPattern.test(text)) return { kind: "reject", reason: "selection_listing" };
  if (noKnifePattern.test(title.replace(/\s+/g, " ").trim())) return { kind: "reject", reason: "no_knives_included" };
  // Unconditional exclusions regardless of stated quantity — checked before any count/folding
  // resolution so a garbage listing can't slip through just because it also mentions "folding" or a
  // known brand name (e.g. "Buck Knife Replacement Blade", "Stanley Folding Box Cutter").
  if (boxCutterPattern.test(text)) return { kind: "reject", reason: "box_cutter" };
  if (creditCardKnifePattern.test(text)) return { kind: "reject", reason: "credit_card_knife" };
  if (coinKnifePattern.test(text)) return { kind: "reject", reason: "coin_knife" };
  if (plainBladePattern.test(text)) return { kind: "reject", reason: "plain_blade" };
  // Weight-priced/randomized grab-bag lots: the buyer receives a random weight-based selection,
  // so no number in the text (nor a photo of the seller's whole pool of stock) reliably states
  // what actually ships. Checked unconditionally, like the other exclusions above.
  if (weightBasedLotPattern.test(text)) return { kind: "reject", reason: "weight_based_lot" };
  const swissArmy = swissArmyPattern.test(text);
  // Non-Swiss-Army multi-tools (corkscrew/bottle-opener combos) are rejected outright; Swiss Army
  // ones are allowed through to resolve normally, but flagged so a stricter price cap applies later.
  if (!swissArmy && multiToolPattern.test(text)) return { kind: "reject", reason: "multi_tool" };
  if (!explicitFoldingSignal(text) && nonFoldingCutleryPattern.test(text)) return { kind: "reject", reason: "non_folding_cutlery" };
  const count = numericCount(title, description);
  if (count && count <= FINDER_DEFAULTS.maxPlausibleKnifeCount && foldingSignal(text)) {
    return { kind: "resolved", count, containsFoldingKnife: true, confidence: 0.99, ...(swissArmy ? { swissArmy: true as const } : {}) };
  }
  if (!lotPattern.test(text) && foldingSignal(text) && knifePattern.test(text)) {
    return { kind: "resolved", count: 1, containsFoldingKnife: true, confidence: 0.95, ...(swissArmy ? { swissArmy: true as const } : {}) };
  }
  return { kind: "vision" };
}

// A listing's matched keywords may include a brand-specific override alongside a generic,
// override-less phrase; the generic match carries no signal that should pull the ceiling down,
// so the highest override among the matched keywords wins.
export function resolveMaxCostPerKnife(matchedPhrases: string[], keywordOverrides: Map<string, number | null | undefined>, defaultMax: number = FINDER_DEFAULTS.maxCostPerKnife): number {
  const overrides = matchedPhrases
    .map((phrase) => keywordOverrides.get(phrase))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return overrides.length ? Math.max(...overrides) : defaultMax;
}

// Swiss Army multi-tools are the one multi-tool category allowed to qualify at all, but only far
// below the normal per-knife ceiling — never above it, even if a keyword override raised the
// normal ceiling past the Swiss Army cap.
export function effectiveMaxCostPerKnife(category: string | null | undefined, baseMax: number, swissArmyMax: number = FINDER_DEFAULTS.swissArmyMaxCostPerKnife): number {
  return category === "swiss_army_multi_tool" ? Math.min(baseMax, swissArmyMax) : baseMax;
}

// Shipping only ever adds cost, so if the item price alone (ignoring shipping) already exceeds
// the ceiling, no shipping value could ever make the listing qualify — not worth spending an
// extra eBay lookup call to find out.
export function isShippingLookupWorthwhile(itemPrice: number, knifeCount: number, max: number = FINDER_DEFAULTS.maxCostPerKnife) {
  return Number.isFinite(itemPrice) && Number.isFinite(knifeCount) && knifeCount > 0 && itemPrice / knifeCount <= max;
}

export function calculateDeal(itemPrice: number, shippingCost: number | null, knifeCount: number, max: number = FINDER_DEFAULTS.maxCostPerKnife) {
  if (!Number.isFinite(itemPrice) || itemPrice < 0) return { qualifies: false, reason: "invalid_price" as const };
  if (shippingCost == null || !Number.isFinite(shippingCost) || shippingCost < 0) return { qualifies: false, reason: "missing_shipping" as const };
  if (!Number.isInteger(knifeCount) || knifeCount < 1) return { qualifies: false, reason: "invalid_count" as const };
  const totalCost = Math.round((itemPrice + shippingCost) * 100) / 100;
  const costPerKnife = totalCost / knifeCount;
  return { qualifies: costPerKnife <= max, reason: costPerKnife <= max ? null : "over_budget", totalCost, costPerKnife };
}

export function monthKey(date = new Date()) { return date.toISOString().slice(0, 7); }

// UTC calendar day, used to key the daily vision-analysis pacing cap (see gemini-vision.ts).
export function dayKey(date = new Date()) { return date.toISOString().slice(0, 10); }

export function isDailyFinderHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value) === 6;
}

export function finderPages(requested: number) {
  const pages: Array<{ offset: number; limit: number }> = [];
  for (let offset = 0; offset < requested; offset += 200) pages.push({ offset, limit: Math.min(200, requested - offset) });
  return pages;
}
