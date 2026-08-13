import { ebayApiBaseUrl } from "./ebay-endpoints";
import { FINDER_DEFAULTS, finderPages } from "./finder-core";

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

async function appToken() {
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

async function browseHeaders() {
  const token = await appToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const zip = process.env.EBAY_FINDER_ZIP || FINDER_DEFAULTS.zip;
  return {
    Authorization: `Bearer ${token}`,
    "X-EBAY-C-MARKETPLACE-ID": marketplace,
    "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3DUS%2Czip%3D${encodeURIComponent(zip)}`,
  };
}

// eBay's item_summary/search endpoint frequently omits a computed shippingCost for listings
// using CALCULATED (weight/location-based) shipping, even with a contextualLocation header —
// the single-item endpoint reliably computes it. Call this only for listings worth the extra
// request (see isShippingLookupWorthwhile in finder-core.ts).
export async function getItemShippingCost(itemId: string) {
  const url = `${ebayApiBaseUrl()}/buy/browse/v1/item/${encodeURIComponent(itemId)}`;
  const response = await fetch(url, { headers: await browseHeaders() });
  if (!response.ok) throw new Error(`eBay item lookup for "${itemId}" failed (${response.status}).`);
  const payload = await response.json() as { shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }> };
  return shippingCost(payload);
}

export async function searchEbayKeyword(keyword: string, requested: number = FINDER_DEFAULTS.resultsPerKeyword) {
  const token = await appToken();
  const marketplace = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const zip = process.env.EBAY_FINDER_ZIP || FINDER_DEFAULTS.zip;
  const result: EbayFinderItem[] = [];
  for (const { offset, limit } of finderPages(requested)) {
    const url = new URL(`${ebayApiBaseUrl()}/buy/browse/v1/item_summary/search`);
    url.searchParams.set("q", keyword);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("fieldgroups", "EXTENDED");
    url.searchParams.set("filter", "deliveryCountry:US");
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3DUS%2Czip%3D${encodeURIComponent(zip)}`,
      },
    });
    if (!response.ok) throw new Error(`eBay search for “${keyword}” failed (${response.status}).`);
    const payload = await response.json() as { itemSummaries?: Array<Record<string, unknown>> };
    const summaries = payload.itemSummaries || [];
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
    if (summaries.length < limit) break;
  }
  return result;
}
