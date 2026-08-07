export const FINDER_DEFAULTS = {
  zip: "32819",
  maxCostPerKnife: 3.5,
  confidence: 0.9,
  resultsPerKeyword: 500,
  monthlyPaidAnalysisLimit: 50_000,
  batchSize: 5,
  maxPlausibleKnifeCount: 50,
} as const;

const numberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, pair: 2,
};

const foldingPattern = /\b(?:folding|foldable|pocket\s*kn(?:ife|ives)|pen\s*kn(?:ife|ives)|penknife|jack\s*kn(?:ife|ives)|jackknife|swiss\s+army)\b/i;
const knifePattern = /\bkn(?:ife|ives)\b/i;
const lotPattern = /\b(?:lot|bulk|assorted|collection|group|bundle)\b/i;
const selectionPattern = /\b(?:choose|choice|select)\s+(?:one|1|a)\b|\b(?:each|per\s+knife|sold\s+separately)\b/i;

export type TextAnalysis =
  | { kind: "reject"; reason: string }
  | { kind: "resolved"; count: number; containsFoldingKnife: true; confidence: number }
  | { kind: "vision" };

// Patterns that require a knife/blade word directly adjacent to the number are safe to trust
// anywhere in the listing text. Patterns that infer a count from lot/piece phrasing without that
// anchor (auction lot numbering, bundled non-knife items, dimensions, model numbers) are only
// trusted against the short seller-authored title, where they're far less likely to misfire.
function numericCount(title: string, description: string) {
  const full = `${title} ${description}`.replace(/\s+/g, " ").trim();
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  const componentPattern = /\b(\d{1,3})\s*(?:(?:folding|pocket|kitchen|fixed[ -]blade)\s+)?(?:kn(?:ife|ives)|fixed\s+blades?)\b/gi;
  const components = [...full.matchAll(componentPattern)].map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0);
  if (components.length > 1) return components.reduce((sum, value) => sum + value, 0);
  const explicitMatch = full.match(/\b(\d{1,3})\s*(?:pocket\s+|folding\s+)?kn(?:ife|ives)\b/i);
  const explicitValue = Number(explicitMatch?.[1]);
  if (Number.isInteger(explicitValue) && explicitValue > 0) return explicitValue;
  if (components.length === 1) return components[0];
  // No generic "x123" pattern here: it's indistinguishable from model numbers like "SOG X42"
  // or dimensions like "4 x 90mm" with no reliable anchor, so those are left to Gemini vision.
  const loosePatterns = [
    /\blot\s+of\s+(\d{1,3})\b/i,
    /\b(\d{1,3})\s*(?:pc|pcs|piece|pieces)\b/i,
  ];
  for (const pattern of loosePatterns) {
    const match = cleanTitle.match(pattern);
    const value = Number(match?.[1]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  const words = Object.keys(numberWords).join("|");
  const wordMatch = full.match(new RegExp(`\\b(?:lot\\s+(?:of\\s+)?)?(${words})\\s+(?:pocket\\s+|folding\\s+)?kn(?:ife|ives)\\b`, "i"));
  return wordMatch ? numberWords[wordMatch[1].toLowerCase()] : null;
}

export function analyzeListingText(title: string, description = ""): TextAnalysis {
  const text = `${title} ${description}`.replace(/\s+/g, " ").trim();
  if (selectionPattern.test(text)) return { kind: "reject", reason: "selection_listing" };
  const count = numericCount(title, description);
  if (count && count <= FINDER_DEFAULTS.maxPlausibleKnifeCount && foldingPattern.test(text)) return { kind: "resolved", count, containsFoldingKnife: true, confidence: 0.99 };
  if (!lotPattern.test(text) && foldingPattern.test(text) && knifePattern.test(text)) {
    return { kind: "resolved", count: 1, containsFoldingKnife: true, confidence: 0.95 };
  }
  return { kind: "vision" };
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

export function isDailyFinderHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value) === 6;
}

export function finderPages(requested: number) {
  const pages: Array<{ offset: number; limit: number }> = [];
  for (let offset = 0; offset < requested; offset += 200) pages.push({ offset, limit: Math.min(200, requested - offset) });
  return pages;
}
