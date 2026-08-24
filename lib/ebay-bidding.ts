import { decryptToken } from "./token-crypto";
import { requiredEnv } from "./runtime-config";
import { supabaseAdmin } from "./supabase-admin";
import { ebayApiBaseUrl } from "./ebay-endpoints";
import { recordEbayApiCall } from "./ebay-call-tracker";

type BidLot = {
  id: string;
  ebay_item_id: string;
  max_bid: number | string;
  currency: string;
  bid_window_start: string;
  bid_window_end: string;
};

type EbayAccount = {
  id: string;
  marketplace: string;
  refresh_token_ciphertext: string | null;
};

async function refreshAccessToken(account: EbayAccount) {
  if (!account.refresh_token_ciphertext) throw new Error("The eBay account has not completed OAuth.");
  const refreshToken = decryptToken(account.refresh_token_ciphertext);
  const clientId = requiredEnv("EBAY_CLIENT_ID");
  const clientSecret = requiredEnv("EBAY_CLIENT_SECRET");
  const response = await fetch(`${ebayApiBaseUrl()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  await recordEbayApiCall();
  if (!response.ok) throw new Error(`eBay token refresh failed (${response.status}).`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("eBay did not return an access token.");
  return payload.access_token;
}

async function resolveRestItemId(accessToken: string, lot: BidLot, marketplace: string) {
  if (lot.ebay_item_id.startsWith("v1|")) return lot.ebay_item_id;
  const url = new URL(`${ebayApiBaseUrl()}/buy/browse/v1/item/get_item_by_legacy_id`);
  url.searchParams.set("legacy_item_id", lot.ebay_item_id);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
    },
  });
  await recordEbayApiCall();
  if (!response.ok) throw new Error(`eBay item lookup failed (${response.status}).`);
  const payload = await response.json() as { itemId?: string };
  if (!payload.itemId) throw new Error("eBay did not return a REST item ID.");
  return payload.itemId;
}

export async function submitProxyBid(lot: BidLot, account: EbayAccount) {
  const accessToken = await refreshAccessToken(account);
  const itemId = await resolveRestItemId(accessToken, lot, account.marketplace || requiredEnv("EBAY_MARKETPLACE_ID"));
  const response = await fetch(`${ebayApiBaseUrl()}/buy/offer/v1_beta/bidding/${encodeURIComponent(itemId)}/place_proxy_bid`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": account.marketplace || requiredEnv("EBAY_MARKETPLACE_ID"),
    },
    body: JSON.stringify({ maxAmount: { currency: lot.currency, value: Number(lot.max_bid).toFixed(2) } }),
  });
  await recordEbayApiCall();
  const payload = await response.json().catch(() => ({})) as { proxyBidId?: string; errors?: Array<{ message?: string }> };
  if (!response.ok) throw new Error(payload.errors?.[0]?.message || `eBay bid submission failed (${response.status}).`);
  return { responseCode: response.status, proxyBidId: payload.proxyBidId || null, itemId };
}

export async function executeBid(lot: BidLot, account: EbayAccount) {
  const idempotencyKey = `${lot.id}:${lot.bid_window_start}`;
  const { data: existing } = await supabaseAdmin.from("bid_attempts").select("id, status").eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing?.status === "submitted") return { status: "already_submitted" as const };
  if (existing?.status === "processing") return { status: "already_processing" as const };

  let attemptId = existing?.id as string | undefined;
  if (attemptId) {
    await supabaseAdmin.from("bid_attempts").update({ status: "processing", error: null }).eq("id", attemptId);
  } else {
    const { data: attempt, error } = await supabaseAdmin.from("bid_attempts").insert({ bid_lot_id: lot.id, idempotency_key: idempotencyKey, status: "processing" }).select("id").single();
    if (error) {
      if (error.code === "23505") return { status: "already_processing" as const };
      throw new Error(error.message);
    }
    attemptId = attempt.id;
  }

  try {
    await supabaseAdmin.from("bid_lots").update({ status: "queued", claimed_at: new Date().toISOString() }).eq("id", lot.id).eq("status", "armed");
    const result = await submitProxyBid(lot, account);
    await supabaseAdmin.from("bid_attempts").update({ status: "submitted", response_code: result.responseCode, error: null }).eq("id", attemptId);
    await supabaseAdmin.from("bid_lots").update({ status: "submitted", submitted_at: new Date().toISOString(), last_error: null }).eq("id", lot.id);
    return { status: "submitted" as const, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown eBay bidding error.";
    await supabaseAdmin.from("bid_attempts").update({ status: "failed", error: message }).eq("id", attemptId);
    await supabaseAdmin.from("bid_lots").update({ status: "failed", last_error: message }).eq("id", lot.id);
    return { status: "failed" as const, error: message };
  }
}
