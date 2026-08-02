export const parseEbayItemId = (value: string) => {
  try {
    const url = new URL(value.trim());
    if (!/(^|\.)ebay\.[a-z.]+$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/(?:itm\/|item\/(?:[^/]+\/)?)(\d{6,14})/i) || url.pathname.match(/\/(\d{6,14})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch { return null; }
};
export const parsePrice = (value: string | number) => typeof value === "number" ? value : Number(String(value).replace(/[^0-9,.-]/g, "").replace(/\./g, "").replace(",", "."));
export const formatBrl = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const canApprove = (listing: { title?: string; description?: string; starting_price_brl?: number; images?: unknown[] }) => Boolean(listing.title?.trim() && listing.description?.trim() && Number(listing.starting_price_brl) > 0 && listing.images?.length);
export const completeText = (title: string, price: number, description: string) => `${title}\n\nComeçar fechamento em: ${formatBrl(price)}\n\n${description}`;

