import { supabaseAdmin } from "./supabase-admin";

export async function createManualBidReminder(lot: { id: string; title: string; ebay_url: string; max_bid: number | string; currency: string }, client = supabaseAdmin) {
  const message = `Manual bid due: ${lot.title} — max ${lot.currency} ${lot.max_bid}. Open the eBay listing and submit it manually.`;
  const { data, error } = await client.from("bid_notifications").upsert({ bid_lot_id: lot.id, kind: "manual_bid_due", message, email_status: "pending" }, { onConflict: "bid_lot_id,kind", ignoreDuplicates: true }).select("id, bid_lot_id, kind, message, created_at, acknowledged_at").maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function createManualBidReminders(lots: Array<{ id: string; title: string; ebay_url: string; max_bid: number | string; currency: string }>, client = supabaseAdmin) {
  const reminders = [];
  for (const lot of lots) reminders.push(await createManualBidReminder(lot, client));
  return reminders;
}
