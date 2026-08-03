import { parseEbayItemId } from "./validation";

const browserHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

const decodeHtml = (value: string) => value
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">");

function readMeta(html: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return "";
}

function readJsonLd(html: string) {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1].trim());
      const entries = Array.isArray(value) ? value : [value];
      const product = entries.find((entry) => entry?.["@type"] === "Product") || entries[0];
      if (product) return {
        title: typeof product.name === "string" ? product.name : "",
        description: typeof product.description === "string" ? product.description : "",
        images: Array.isArray(product.image) ? product.image : typeof product.image === "string" ? [product.image] : []
      };
    } catch {
      // eBay may include JSON-LD fragments that are not valid JSON.
    }
  }
  return { title: "", description: "", images: [] as string[] };
}

async function resolveEbayUrl(url: string) {
  const initialId = parseEbayItemId(url);
  if (initialId) return { url, itemId: initialId };
  try {
    const response = await fetch(url, { headers: browserHeaders, redirect: "follow" });
    const resolvedUrl = response.url || url;
    const itemId = parseEbayItemId(resolvedUrl);
    if (itemId) return { url: resolvedUrl, itemId };
  } catch {
    // Fall through to the friendly validation error below.
  }
  throw new Error("Link do eBay inválido ou não foi possível abrir o anúncio.");
}

async function getPublicEbayListing(url: string, itemId: string) {
  const pageUrl = `https://www.ebay.com/itm/${itemId}`;
  const response = await fetch(pageUrl, { headers: browserHeaders, redirect: "follow" });
  if (!response.ok) throw new Error("Anúncio do eBay não encontrado ou indisponível.");
  const html = await response.text();
  const jsonLd = readJsonLd(html);
  const title = readMeta(html, "og:title") || jsonLd.title || readMeta(html, "twitter:title");
  const description = readMeta(html, "og:description") || jsonLd.description || readMeta(html, "description");
  const images = [readMeta(html, "og:image"), ...jsonLd.images]
    .filter((image): image is string => Boolean(image) && /^https?:\/\//i.test(image));
  if (!title) throw new Error("O eBay não disponibilizou os dados públicos deste anúncio.");
  return { itemId, title, description, imageUrls: [...new Set(images)] };
}

export async function getEbayListing(url: string) {
  const resolved = await resolveEbayUrl(url);
  const { itemId } = resolved;
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  // The app is usable without an eBay developer account. Use the public listing
  // page when Browse API credentials were intentionally skipped or unavailable.
  if (!clientId || !clientSecret) return getPublicEbayListing(resolved.url, itemId);

  try {
    const tokenResponse = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope"
    });
    if (!tokenResponse.ok) return getPublicEbayListing(resolved.url, itemId);
    const { access_token } = await tokenResponse.json();
    const response = await fetch(`https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE_ID || "EBAY_US"
      }
    });
    if (!response.ok) return getPublicEbayListing(resolved.url, itemId);
    const item = await response.json();
    return {
      itemId,
      title: item.title || "",
      description: String(item.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      imageUrls: (item.image?.imageUrl ? [item.image.imageUrl] : []).concat((item.additionalImages || []).map((image: { imageUrl: string }) => image.imageUrl))
    };
  } catch {
    return getPublicEbayListing(resolved.url, itemId);
  }
}
