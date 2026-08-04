import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase-admin";

export type BidStatus = "draft" | "armed" | "queued" | "submitted" | "outbid" | "won" | "lost" | "failed" | "cancelled";

export async function listBidData() {
  const [{ data: bids, error }, { data: accounts, error: accountError }] = await Promise.all([
    supabaseAdmin.from("bid_lots").select("*, ebay_accounts(id, label, marketplace, status), bid_notifications(id, kind, message, created_at, acknowledged_at)").order("created_at", { ascending: false }),
    supabaseAdmin.from("ebay_accounts").select("id, label, marketplace, status, ebay_username, created_at").order("created_at", { ascending: false }),
  ]);
  if (error || accountError) throw new Error(error?.message || accountError?.message || "Could not load bidding data.");
  return { bids: bids || [], accounts: accounts || [] };
}

export function makeIdempotencyKey(bidId: string) {
  return `${bidId}:${randomUUID()}`;
}
