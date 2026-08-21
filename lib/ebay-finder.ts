import { ebayApiBaseUrl } from "./ebay-endpoints";
import { FINDER_DEFAULTS, finderPages } from "./finder-core";

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
};

export async function appToken() {
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
  if (!response.ok) throw new Error(`eBay token request failed (${response.status}).`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("eBay did not return an application token.");
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
  const url = `${ebayApiBaseUrl()}/buy/browse/v1/item/${encodeURIComponent(itemId)}`;
  const response = await fetch(url, { headers: await browseHeaders(token), signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`eBay item lookup for "${itemId}" failed (${response.status}).`);
  const payload = await response.json() as { description?: string };
  if (!payload.description) return "";
  return htmlToText(payload.description).slice(0, 4000);
}

function parseItemSummaries(summaries: Array<Record<string, unknown>>): EbayFinderItem[] {
  const result: EbayFinderItem[] = [];
  for (const raw of summaries) {
    const item = raw as {
      itemId?: string; title?: string; shortDescription?: string; itemWebUrl?: string;
      image?: { imageUrl?: string }; price?: { value?: string; currency?: string };
      shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }>;
      buyingOptions?: string[]; itemEndDate?: string;
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
export async function searchEbayKeyword(keyword: string, requested: number = FINDER_DEFAULTS.resultsPerKeyword, token?: string, extraExcludeTerms: string[] = [], conditionId?: string) {
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
    const filterParts = ["deliveryCountry:US"];
    if (conditionId) filterParts.push(`conditionIds:{${conditionId}}`);
    url.searchParams.set("filter", filterParts.join(","));
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3DUS%2Czip%3D${encodeURIComponent(zip)}`,
      },
      signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
    });
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
    if (!response.ok) throw new Error(`eBay category browse for "${categoryId}" failed (${response.status}).`);
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
export async function searchEbayByImage(imageBase64: string, requested: number, token?: string): Promise<EbayFinderItem[]> {
  const authToken = token || await appToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const result: EbayFinderItem[] = [];
  for (const { offset, limit } of finderPages(requested)) {
    const url = new URL(`${ebayApiBaseUrl("production")}/buy/browse/v1/item_summary/search_by_image`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "X-EBAY-C-MARKETPLACE-ID": marketplace, "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageBase64 }),
      signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`eBay image search failed (${response.status}).`);
    const payload = await response.json() as { itemSummaries?: Array<Record<string, unknown>> };
    const summaries = payload.itemSummaries || [];
    result.push(...parseItemSummaries(summaries));
    if (summaries.length < limit) break;
  }
  return result;
}
