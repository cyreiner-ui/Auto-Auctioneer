import { NextResponse } from "next/server";
import { finderTick } from "@/lib/finder-service";
import { isSchedulerRequest } from "@/lib/scheduler-auth";
import { requireStaff } from "@/lib/staff-auth";

// finderTick's eBay/Gemini calls need the Node runtime and more time than
// the platform default. It does NOT need playwright-core/@sparticuz/chromium
// (see lib/gixen-format.ts) — keep it that way so this route's deployed
// function bundle stays small.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isSchedulerRequest(request.headers) && !(await requireStaff(request))) return NextResponse.json({ error: "Staff or scheduler access required." }, { status: 403 });
  try { return NextResponse.json(await finderTick()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Finder tick failed." }, { status: 500 }); }
}
