import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { updateMateGourdSettings } from "@/lib/finder-service";

// Mirrors app/api/finder/gaucho-settings/route.ts, but for the maté-gourd pipeline's
// keyword-search-supplement toggle (see updateMateGourdSettings). The separate per-category
// processing pause lives at app/api/finder/processing-paused/route.ts.
export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  if (typeof body.keyword_search_enabled !== "boolean") return NextResponse.json({ error: "keyword_search_enabled must be a boolean." }, { status: 400 });
  try {
    await updateMateGourdSettings({ keywordSearchEnabled: body.keyword_search_enabled });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the setting." }, { status: 500 });
  }
}
