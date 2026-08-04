type BidInput = Record<string, unknown>;

export type NormalizedBidInput = {
  ebayItemId: string;
  ebayUrl: string;
  title: string;
  accountId: string;
  maxBid: number;
  currency: string;
  allInBudget: number | null;
  auctionEndAt: string | null;
  bidWindowStart: string;
  bidWindowEnd: string;
};

type ValidationResult = { ok: true; value: NormalizedBidInput } | { ok: false; error: string };

function parseEbayItemId(value: string) {
  try {
    const url = new URL(value.trim());
    if (!/(^|\.)ebay\.[a-z.]+$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/(?:itm\/|item\/(?:[^/]+\/)?)(\d{6,14})/i) || url.pathname.match(/\/(\d{6,14})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function isEbayListingUrl(value: string) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && /(^|\.)ebay\.[a-z.]+$/i.test(url.hostname) && Boolean(parseEbayItemId(value));
  } catch {
    return false;
  }
}

function isRestItemId(value: string) {
  return /^v1\|[^|]+\|\d+$/.test(value);
}

function normalizeDate(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function optionalAmount(value: unknown): { value: number | null; error?: string } {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return { value: null };
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return { value: null, error: "Amounts must be greater than zero." };
  return { value: amount };
}

export function validateBidInput(input: BidInput): ValidationResult {
  const ebayItemId = String(input.ebayItemId || "").trim();
  const ebayUrl = String(input.ebayUrl || "").trim();
  const accountId = String(input.accountId || "").trim();
  const start = normalizeDate(input.bidWindowStart);
  const end = normalizeDate(input.bidWindowEnd);
  const auctionEndAt = input.auctionEndAt === undefined || input.auctionEndAt === null || input.auctionEndAt === "" ? null : normalizeDate(input.auctionEndAt);
  const maxBid = Number(input.maxBid);
  const budget = optionalAmount(input.allInBudget);
  const currency = String(input.currency || "USD").trim().toUpperCase();

  if (!ebayItemId || !ebayUrl || !accountId || !start || !end) return { ok: false, error: "Item, account, max bid, and bid window are required." };
  if (!isEbayListingUrl(ebayUrl)) return { ok: false, error: "A valid eBay listing URL is required." };
  if (!isRestItemId(ebayItemId) && !/^\d{6,14}$/.test(ebayItemId)) return { ok: false, error: "A valid eBay item ID is required." };
  if (!Number.isFinite(maxBid) || maxBid <= 0) return { ok: false, error: "Max bid must be greater than zero." };
  if (budget.error) return { ok: false, error: budget.error };
  if (budget.value !== null && budget.value < maxBid) return { ok: false, error: "All-in budget cannot be below the max bid." };
  if (auctionEndAt === null && input.auctionEndAt !== undefined && input.auctionEndAt !== null && input.auctionEndAt !== "") return { ok: false, error: "Auction end must be a valid date." };
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Currency must be a three-letter code." };
  if (new Date(end).getTime() <= new Date(start).getTime()) return { ok: false, error: "Bid window end must be after its start." };

  return {
    ok: true,
    value: {
      ebayItemId,
      ebayUrl,
      title: String(input.title || "Untitled eBay lot").trim() || "Untitled eBay lot",
      accountId,
      maxBid,
      currency,
      allInBudget: budget.value,
      auctionEndAt,
      bidWindowStart: start,
      bidWindowEnd: end,
    },
  };
}
