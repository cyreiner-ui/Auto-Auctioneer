import { NextResponse } from "next/server";
import { processPendingFinderItems, startFinderRun } from "@/lib/finder-service";
import { requireStaff } from "@/lib/staff-auth";

// Gixen auto-send now drives a headless browser (see lib/gixen-client.ts),
// which needs the Node runtime and more time than the platform default.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  try {
    const run = await startFinderRun("manual");
    const queue = await processPendingFinderItems();
    return NextResponse.json({ run, queue });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not start finder." }, { status: 500 }); }
}
