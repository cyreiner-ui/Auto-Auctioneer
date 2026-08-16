import { NextResponse } from "next/server";
import { processPendingFinderItems, startFinderRun, type FinderCategory } from "@/lib/finder-service";
import { requireStaff } from "@/lib/staff-auth";

// Gixen auto-send now drives a headless browser (see lib/gixen-client.ts),
// which needs the Node runtime and more time than the platform default.
export const runtime = "nodejs";
export const maxDuration = 60;

function parseCategory(value: unknown): FinderCategory | undefined {
  return value === "pocket_knife" || value === "carving_set" ? value : undefined;
}

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  try {
    // Omitting `category` keeps today's unscoped behavior (scans every enabled keyword) — the two
    // staff "Run now" buttons each pass their own category so a pocket-knife run and a carving-set
    // run can proceed independently without blocking each other (see startFinderRun/findActiveRun).
    const run = await startFinderRun("manual", undefined, parseCategory(body?.category));
    const queue = await processPendingFinderItems();
    return NextResponse.json({ run, queue });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not start finder." }, { status: 500 }); }
}
