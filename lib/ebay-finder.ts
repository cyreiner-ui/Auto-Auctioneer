import { ebayApiBaseUrl } from "./ebay-endpoints";
import { FINDER_DEFAULTS, finderPages } from "./finder-core";
import { recordEbayApiCall } from "./ebay-call-tracker";

// Every fetch below carries this timeout. Without one, a single stalled eBay response left
// startFinderRun's per-item description-fetch mapWithConcurrency batch (hundreds of individual
// item lookups) stuck holding a concurrency slot forever — the whole scan sat at 0 items_seen
// until the 15-minute finder_runs watchdog killed it (confirmed twice in production: a scheduled
// and a manual carving_set run, both stuck mid-batch with no further progress). A timeout turns a
// hung request into an ordinary rejected promise, which every call site already catches per-item.
const EBAY_REQUEST_TIMEOUT_MS = 20_000;

export type EbayFinderItem = {
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
  // eBay's itemLocation.country (ISO code, e.g. "US") — where the item physically ships from. Only
  // set when eBay reports it; the Damascus finder rejects anything not located in the US.
  itemLocationCountry?: string;
  // Set when the search result is (part of) a multi-variation listing — eBay returns itemGroupType/
  // itemGroupHref for those, and the price shown is only one variation's (usually the cheapest).
  itemGroupType?: string;
};

// Cached at module scope (not just per-run/per-tick the way startFinderRun's local `token`
// variable and processPendingFinderItems's tokenForLookup already do) so a warm serverless
// container reuses one token across an eBay-issued ~2-hour lifetime instead of spending a fresh
// OAuth round trip on every single scheduler tick that touches eBay — one more call this app was
// making needlessly against the same shared, scarce daily Browse API budget. Refreshed a few
// minutes early so a token is never handed out right as it's about to expire. Harmless on a cold
// start (the cache is simply empty and this falls back to a fresh fetch), so this only ever helps.
let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Test-only: clears the cache so each test gets its own fresh token fetch instead of silently
// reusing whatever an earlier test in the same file already cached (see tests/helpers/fake-fetch.mjs).
export function resetAppTokenCacheForTests() { cachedToken = null; }

export async function appToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("eBay API credentials are not configured.");
  const response = await fetch(`${ebayApiBaseUrl()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
  });
  await recordEbayApiCall();
  if (!response.ok) throw new Error(`eBay token request failed (${response.status}).`);
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error("eBay did not return an application token.");
  const ttlMs = (Number(payload.expires_in) || 7200) * 1000;
  cachedToken = { token: payload.access_token, expiresAt: Date.now() + Math.max(ttlMs - TOKEN_REFRESH_MARGIN_MS, 0) };
  return payload.access_token;
}

function shippingCost(item: { shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }> }) {
  const costs = (item.shippingOptions || []).map((option) => ({ value: Number(option.shippingCost?.value), currency: option.shippingCost?.currency || "" })).filter((entry) => Number.isFinite(entry.value) && entry.value >= 0).sort((a, b) => a.value - b.value);
  return costs[0] || { value: null, currency: "" };
}

async function browseHeaders(token?: string) {
  const authToken = token || await appToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const zip = process.env.EBAY_FINDER_ZIP || FINDER_DEFAULTS.zip;
  return {
    Authorization: `Bearer ${authToken}`,
    "X-EBAY-C-MARKETPLACE-ID": marketplace,
    "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3DUS%2Czip%3D${encodeURIComponent(zip)}`,
  };
}

// eBay's item_summary/search endpoint frequently omits a computed shippingCost for listings
// using CALCULATED (weight/location-based) shipping, even with a contextualLocation header —
// the single-item endpoint reliably computes it. Call this only for listings worth the extra
// request (see isShippingLookupWorthwhile in finder-core.ts). Pass a pre-fetched `token` when
// calling this repeatedly (e.g. once per pending-queue batch) to avoid a fresh OAuth round trip
// per item — each one is a real network call and adds up fast against a serverless timeout.
export async function getItemShippingCost(itemId: string, token?: string) {
  const url = `${ebayApiBaseUrl()}/buy/browse/v1/item/${encodeURIComponent(itemId)}`;
  const response = await fetch(url, { headers: await browseHeaders(token), signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS) });
  await recordEbayApiCall();
  if (!response.ok) throw new Error(`eBay item lookup for "${itemId}" failed (${response.status}).`);
  const payload = await response.json() as { shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }> };
  return shippingCost(payload);
}

const HTML_BLOCK_TAGS = /<\/(?:p|div|li|tr|h[1-6])>|<br\s*\/?>/gi;

function htmlToText(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(HTML_BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();
}

// The Browse API's single-item endpoint (same one getItemShippingCost above already calls) returns
// the seller's full HTML description — the item_summary/search endpoint's `shortDescription` is
// often blank or truncated, which is exactly what leaves genuinely-informative listings (material,
// maker, condition) falling through to a vision call instead of resolving from text. Callers that
// need both shipping and description for the same item should call this once rather than calling
// getItemShippingCost separately, to avoid two requests for one listing. Truncated to a few KB,
// matching the truncation already applied to Gemini prompts elsewhere in this codebase.
export async function getItemDescription(itemId: string, token?: string) {
  return (await getItemDetails(itemId, token)).description;
}

// Same single-item call as getItemDescription (one eBay request), also reporting whether the
// listing is a multi-variation ("choose an option") listing: the Browse API returns a
// primaryItemGroup for an item that belongs to a seller-defined variation group, and its price is
// then only that one variation's — not whatever set size the title advertises.
export async function getItemDetails(itemId: string, token?: string): Promise<{ description: string; itemGroupType: string | null }> {
  const url = `${ebayApiBaseUrl()}/buy/browse/v1/item/${encodeURIComponent(itemId)}`;
  const response = await fetch(url, { headers: await browseHeaders(token), signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS) });
  await recordEbayApiCall();
  if (!response.ok) {
    // eBay refuses a plain item id for a listing that has variations, pointing at the item-group
    // endpoint instead (errorId 11006, "get_items_by_item_group") — that refusal is itself the
    // answer: it's a multi-variation listing.
    const body = await response.text().catch(() => "");
    if (response.status === 400 && /11006|item_group/i.test(body)) return { description: "", itemGroupType: "SELLER_DEFINED_VARIATIONS" };
    throw new Error(`eBay item lookup for "${itemId}" failed (${response.status}).`);
  }
  const payload = await response.json() as { description?: string; primaryItemGroup?: { itemGroupType?: string; itemGroupId?: string } };
  const itemGroupType = payload.primaryItemGroup ? (payload.primaryItemGroup.itemGroupType || "SELLER_DEFINED_VARIATIONS") : null;
  return { description: payload.description ? htmlToText(payload.description).slice(0, 4000) : "", itemGroupType };
}

function parseItemSummaries(summaries: Array<Record<string, unknown>>): EbayFinderItem[] {
  const result: EbayFinderItem[] = [];
  for (const raw of summaries) {
    const item = raw as {
      itemId?: string; title?: string; shortDescription?: string; itemWebUrl?: string;
      image?: { imageUrl?: string }; price?: { value?: string; currency?: string };
      shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }>;
      buyingOptions?: string[]; itemEndDate?: string; itemLocation?: { country?: string }; itemGroupType?: string; itemGroupHref?: string;
    };
    if (!item.itemId || !item.title || !item.itemWebUrl) continue;
    const shipping = shippingCost(item);
    result.push({
      itemId: item.itemId,
      title: item.title,
      shortDescription: item.shortDescription || "",
      itemWebUrl: item.itemWebUrl,
      imageUrl: item.image?.imageUrl || null,
      itemPrice: Number(item.price?.value),
      shippingCost: shipping.value,
      shippingCurrency: shipping.currency,
      currency: item.price?.currency || "",
      buyingOptions: item.buyingOptions || [],
      itemEndDate: item.itemEndDate || null,
      ...(item.itemLocation?.country ? { itemLocationCountry: item.itemLocation.country } : {}),
      ...(item.itemGroupType || item.itemGroupHref ? { itemGroupType: item.itemGroupType || "SELLER_DEFINED_VARIATIONS" } : {}),
    });
  }
  return result;
}

// Pass a pre-fetched `token` when calling this once per keyword in a loop (e.g. startFinderRun's
// scan across every enabled keyword) so the run doesn't pay for a fresh OAuth round trip per
// keyword — with 35+ keywords that's dozens of avoidable network calls stacked inside one
// request's time budget.
//
// conditionId, when passed, restricts results to that eBay condition ID (e.g. "3000" for Used —
// see CARVING_SET_USED_CONDITION_ID in lib/carving-set-finder.ts). Left undefined by every
// pocket-knife-pipeline caller, which keeps searching every condition unchanged.
//
// sort, when passed, is forwarded as-is (e.g. "newlyListed"); omitted, the Browse API defaults to
// its own relevance ranking ("Best Match"). That default ranking is what every caller used before
// this parameter existed, and still is unless a caller opts into something else — see
// itemLocationCountry, when passed (e.g. "US"), restricts results to items physically located in
// that country (eBay's itemLocationCountry filter) — on top of the deliveryCountry:US filter every
// search already has, which only means "will ship to the US". The Damascus finder passes "US" so
// overseas-shipped imports never come back at all.
//
// startFinderRun's supplemental newlyListed pass in lib/finder-service.ts for why relevance
// ranking alone isn't enough: a brand-new, low-engagement listing (no bids/watchers yet) can rank
// outside even a few hundred best-match results whenever the keyword's total match volume is
// large, so a purely relevance-ranked search can silently miss it for as long as it stays
// low-engagement — which, for an auction ending in a few days, may be its entire listing window.
export async function searchEbayKeyword(keyword: string, requested: number = FINDER_DEFAULTS.resultsPerKeyword, token?: string, extraExcludeTerms: string[] = [], conditionId?: string, sort?: string, itemLocationCountry?: string) {
  const authToken = token || await appToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const zip = process.env.EBAY_FINDER_ZIP || FINDER_DEFAULTS.zip;
  const result: EbayFinderItem[] = [];
  for (const { offset, limit } of finderPages(requested)) {
    const url = new URL(`${ebayApiBaseUrl()}/buy/browse/v1/item_summary/search`);
    // eBay's Browse API q param supports "-word" exclusion syntax; trims the clearest junk
    // (throwing knives, keychain knives, multi-tools, Leatherman) before it's even fetched. See
    // FINDER_DEFAULTS.excludeTerms for why the list stays narrow. extraExcludeTerms lets a caller
    // (lib/finder-service.ts, for carving-set keywords) layer on additional per-search exclusions
    // — e.g. CARVING_SET_MODERN_ORIGIN_EXCLUDE_TERMS — without widening every other keyword's search.
    const excludeTerms = [...FINDER_DEFAULTS.excludeTerms, ...extraExcludeTerms];
    const query = excludeTerms.length ? `${keyword} ${excludeTerms.map((term) => `-${term}`).join(" ")}` : keyword;
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("fieldgroups", "EXTENDED");
    if (sort) url.searchParams.set("sort", sort);
    const filterParts = ["deliveryCountry:US"];
    if (conditionId) filterParts.push(`conditionIds:{${conditionId}}`);
    if (itemLocationCountry) filterParts.push(`itemLocationCountry:${itemLocationCountry}`);
    url.searchParams.set("filter", filterParts.join(","));
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3DUS%2Czip%3D${encodeURIComponent(zip)}`,
      },
      signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
    });
    await recordEbayApiCall();
    if (!response.ok) throw new Error(`eBay search for “${keyword}” failed (${response.status}).`);
    const payload = await response.json() as { itemSummaries?: Array<Record<string, unknown>> };
    const summaries = payload.itemSummaries || [];
    result.push(...parseItemSummaries(summaries));
    if (summaries.length < limit) break;
  }
  return result;
}

// A pure category browse — no q= text search at all — for the carving-set pipeline's daily scan.
// See CARVING_SET_CATEGORY_ID in lib/carving-set-finder.ts for why: antique carving/fish-knife sets
// are routinely listed under eBay's own "Flatware Sets" category without ever using the words
// "carving set" in the title or description, so no phrase-based searchEbayKeyword call above can
// find them. Sorted newest-first and run once per carving-set scan, independent of any
// finder_keywords row.
export async function searchEbayCategoryNewlyListed(categoryId: string, requested: number, token: string | undefined, conditionId: string) {
  const authToken = token || await appToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const zip = process.env.EBAY_FINDER_ZIP || FINDER_DEFAULTS.zip;
  const result: EbayFinderItem[] = [];
  for (const { offset, limit } of finderPages(requested)) {
    const url = new URL(`${ebayApiBaseUrl()}/buy/browse/v1/item_summary/search`);
    url.searchParams.set("category_ids", categoryId);
    url.searchParams.set("sort", "newlyListed");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("fieldgroups", "EXTENDED");
    url.searchParams.set("filter", `deliveryCountry:US,conditionIds:{${conditionId}}`);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3DUS%2Czip%3D${encodeURIComponent(zip)}`,
      },
      signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
    });
    await recordEbayApiCall();
    if (!response.ok) throw new Error(`eBay category browse for "${categoryId}" failed (${response.status}).`);
    const payload = await response.json() as { itemSummaries?: Array<Record<string, unknown>> };
    const summaries = payload.itemSummaries || [];
    result.push(...parseItemSummaries(summaries));
    if (summaries.length < limit) break;
  }
  return result;
}

// A structured-field browse — filters on eBay's own "Brand" item specific within one category,
// not a q= title search at all — for the pocket-knife pipeline's named-brand keywords. See
// POCKET_KNIFE_BRAND_ASPECT_BY_PHRASE in lib/finder-core.ts for why this exists: a seller
// routinely fills in Brand correctly as an item specific while writing a vague title ("Estate lot
// of vintage pocket knives") that a free-text searchEbayKeyword call for "buck knife lot" would
// never match. eBay's aspect_filter syntax requires the category id to appear twice — once as its
// own query param, once again inside aspect_filter itself.
export async function searchEbayBrandCategory(categoryId: string, brand: string, requested: number, token?: string, sort?: string) {
  const authToken = token || await appToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const zip = process.env.EBAY_FINDER_ZIP || FINDER_DEFAULTS.zip;
  const result: EbayFinderItem[] = [];
  for (const { offset, limit } of finderPages(requested)) {
    const url = new URL(`${ebayApiBaseUrl()}/buy/browse/v1/item_summary/search`);
    url.searchParams.set("category_ids", categoryId);
    url.searchParams.set("aspect_filter", `categoryId:${categoryId},Brand:{${brand}}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("fieldgroups", "EXTENDED");
    if (sort) url.searchParams.set("sort", sort);
    url.searchParams.set("filter", "deliveryCountry:US");
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3DUS%2Czip%3D${encodeURIComponent(zip)}`,
      },
      signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
    });
    await recordEbayApiCall();
    if (!response.ok) throw new Error(`eBay brand category browse for "${brand}" failed (${response.status}).`);
    const payload = await response.json() as { itemSummaries?: Array<Record<string, unknown>> };
    const summaries = payload.itemSummaries || [];
    result.push(...parseItemSummaries(summaries));
    if (summaries.length < limit) break;
  }
  return result;
}

// eBay's searchByImage Browse API method — a limited-release endpoint requiring separate
// business-unit approval from eBay (confirmed working for this app's credentials via a one-off
// production probe; see PR history). Not supported in eBay's Sandbox at all, so this always hits
// the production host regardless of EBAY_ENVIRONMENT. Used by the gaucho-knife finder
// (lib/gaucho-knife-finder.ts) to discover candidates by visual similarity to staff-uploaded
// reference photos, rather than by keyword — real gaucho knives are frequently mislabeled by
// sellers who don't recognize what they have, so a text-based search alone would miss them.
// `requested` is deliberately expected to be small (one page, not deep pagination): the response's
// own `total` field is documented by eBay as unreliable for pagination use, and this shares the
// same app-wide 5,000-calls/day Browse API budget as every other eBay call this app makes.
//
// conditionId, when passed, restricts results the same way searchEbayKeyword's does (search_by_image
// supports the same `filter` query param) — e.g. CARVING_SET_USED_CONDITION_ID for Used-only.
export async function searchEbayByImage(imageBase64: string, requested: number, token?: string, conditionId?: string): Promise<EbayFinderItem[]> {
  const authToken = token || await appToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const result: EbayFinderItem[] = [];
  for (const { offset, limit } of finderPages(requested)) {
    const url = new URL(`${ebayApiBaseUrl("production")}/buy/browse/v1/item_summary/search_by_image`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (conditionId) url.searchParams.set("filter", `conditionIds:{${conditionId}}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "X-EBAY-C-MARKETPLACE-ID": marketplace, "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageBase64 }),
      signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
    });
    await recordEbayApiCall();
    if (!response.ok) throw new Error(`eBay image search failed (${response.status}).`);
    const payload = await response.json() as { itemSummaries?: Array<Record<string, unknown>> };
    const summaries = payload.itemSummaries || [];
    result.push(...parseItemSummaries(summaries));
    if (summaries.length < limit) break;
  }
  return result;
}
