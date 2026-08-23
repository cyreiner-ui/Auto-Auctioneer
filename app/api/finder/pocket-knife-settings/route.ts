import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { updatePocketKnifeSettings } from "@/lib/finder-service";

export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const maxCostPerKnife = Number(body.max_cost_per_knife);
  if (!Number.isFinite(maxCostPerKnife) || maxCostPerKnife <= 0) return NextResponse.json({ error: "Enter a valid per-knife price greater than 0." }, { status: 400 });
  try {
    await updatePocketKnifeSettings({ maxCostPerKnife: Math.round(maxCostPerKnife * 100) / 100 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the setting." }, { status: 500 });
  }
}
