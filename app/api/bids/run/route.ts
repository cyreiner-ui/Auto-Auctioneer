import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireStaff } from "@/lib/staff-auth";

export async function POST(request: Request) {
  const schedulerAuthorized = Boolean(process.env.BID_SCHEDULER_SECRET && request.headers.get("x-bid-scheduler-secret") === process.env.BID_SCHEDULER_SECRET);
  if (!schedulerAuthorized && !(await requireStaff(request))) return NextResponse.json({ error: "Staff or scheduler access required." }, { status: 403 });
  if (process.env.EBAY_LIVE_BIDDING_ENABLED !== "true") return NextResponse.json({ enabled: false, message: "Live eBay bidding is disabled until Offer API approval and credentials are configured." }, { status: 503 });
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from("bid_lots").select("id, title, status, bid_window_start, bid_window_end").eq("status", "armed").lte("bid_window_start", now).gte("bid_window_end", now).limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ enabled: true, claimed: data || [], message: "Offer API executor is ready for configured accounts." });
}
