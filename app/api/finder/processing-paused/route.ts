import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { isFinderCategory, updateProcessingPaused, type FinderCategory } from "@/lib/finder-service";

function parseCategory(value: unknown): FinderCategory | null {
  return isFinderCategory(value) ? value : null;
}

// Mirrors app/api/finder/schedule/route.ts's category-scoped PATCH shape, but for the
// per-category vision/classification pause (see updateProcessingPaused) — wired separately for
// each of the three finder tracks rather than one shared switch.
export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const category = parseCategory(body?.category);
  if (!category) return NextResponse.json({ error: "A valid finder category is required." }, { status: 400 });
  if (typeof body.paused !== "boolean") return NextResponse.json({ error: "paused must be a boolean." }, { status: 400 });
  try {
    await updateProcessingPaused(category, body.paused);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the setting." }, { status: 500 });
  }
}
