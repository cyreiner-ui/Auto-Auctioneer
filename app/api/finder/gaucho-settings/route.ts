import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { updateGauchoSettings } from "@/lib/finder-service";

// Mirrors app/api/finder/pocket-knife-settings/route.ts, but for the gaucho-knife pipeline's
// keyword-search-supplement toggle (see updateGauchoSettings).
export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  if (typeof body.keyword_search_enabled !== "boolean") return NextResponse.json({ error: "keyword_search_enabled must be a boolean." }, { status: 400 });
  try {
    await updateGauchoSettings({ keywordSearchEnabled: body.keyword_search_enabled });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the setting." }, { status: 500 });
  }
}
