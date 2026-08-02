import { parseEbayItemId } from "./validation";

async function resolveEbayUrl(url: string) {
  const initialId = parseEbayItemId(url);
  if (initialId) return { url, itemId: initialId };
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow" });
    const resolvedUrl = response.url || url;
    const itemId = parseEbayItemId(resolvedUrl);
    if (itemId) return { url: resolvedUrl, itemId };
  } catch {
    // Convert network/redirect failures into the same human-readable import error.
  }
  throw new Error("Link do eBay inválido ou não foi possível abrir o anúncio.");
}

export async function getEbayListing(url: string) {
  const resolved = await resolveEbayUrl(url);
  const { itemId } = resolved;
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://api.ebay.com/identity/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope" });
  } catch {
    throw new Error("Não foi possível conectar à API do eBay. Verifique a conexão de rede do servidor.");
  }
  if (!tokenResponse.ok) throw new Error("Não foi possível autenticar com o eBay.");
  const { access_token } = await tokenResponse.json();
  let response: Response;
  try {
    response = await fetch(`https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`, { headers: { Authorization: `Bearer ${access_token}`, "X-EBAY-C-MARKETPLACE-ID": process.env.EBAY_MARKETPLACE_ID || "EBAY_US" } });
  } catch {
    throw new Error("Não foi possível consultar o anúncio no eBay. Verifique a conexão de rede do servidor.");
  }
  if (!response.ok) throw new Error("Anúncio do eBay não encontrado ou indisponível.");
  const item = await response.json();
  return { itemId, title: item.title || "", description: String(item.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), imageUrls: (item.image?.imageUrl ? [item.image.imageUrl] : []).concat((item.additionalImages || []).map((image: { imageUrl: string }) => image.imageUrl)) };
}
