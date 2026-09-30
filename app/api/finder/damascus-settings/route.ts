import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { updateDamascusSettings } from "@/lib/finder-service";

// The Damascus pipeline's two per-knife ceilings: standard (pocket/bowie/other) and kitchen/chef.
// Either may be sent alone.
function parsePrice(value: unknown): { ok: true; value: number | undefined } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false };
  return { ok: true, value: Math.round(parsed * 100) / 100 };
}

export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const standard = parsePrice(body.max_cost_per_knife);
  const kitchen = parsePrice(body.kitchen_max_cost_per_knife);
  if (!standard.ok || !kitchen.ok) return NextResponse.json({ error: "Enter a valid per-knife price greater than 0." }, { status: 400 });
  if (standard.value === undefined && kitchen.value === undefined) return NextResponse.json({ error: "Enter a per-knife price to save." }, { status: 400 });
  try {
    await updateDamascusSettings({ maxCostPerKnife: standard.value, kitchenMaxCostPerKnife: kitchen.value });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the setting." }, { status: 500 });
  }
}
