import { NextResponse } from "next/server";
import { updateScheduleSettings, type FinderCategory } from "@/lib/finder-service";
import { requireStaff } from "@/lib/staff-auth";

function parseCategory(value: unknown): FinderCategory | null {
  return value === "pocket_knife" || value === "carving_set" ? value : null;
}

export async function PATCH(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const category = parseCategory(body?.category);
  if (!category) return NextResponse.json({ error: "A valid finder category is required." }, { status: 400 });
  if (body.frequency !== undefined && body.frequency !== "daily" && body.frequency !== "weekly") {
    return NextResponse.json({ error: "Frequency must be \"daily\" or \"weekly\"." }, { status: 400 });
  }
  if (body.hour !== undefined && (!Number.isInteger(body.hour) || body.hour < 0 || body.hour > 23)) {
    return NextResponse.json({ error: "Hour must be an integer between 0 and 23." }, { status: 400 });
  }
  if (body.minute !== undefined && (!Number.isInteger(body.minute) || body.minute < 0 || body.minute > 59)) {
    return NextResponse.json({ error: "Minute must be an integer between 0 and 59." }, { status: 400 });
  }
  if (body.dayOfWeek !== undefined && body.dayOfWeek !== null && (!Number.isInteger(body.dayOfWeek) || body.dayOfWeek < 0 || body.dayOfWeek > 6)) {
    return NextResponse.json({ error: "Day of week must be an integer between 0 (Sunday) and 6 (Saturday), or null." }, { status: 400 });
  }
  try {
    await updateScheduleSettings(category, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      frequency: body.frequency,
      hour: body.hour,
      minute: body.minute,
      dayOfWeek: body.dayOfWeek,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update the schedule." }, { status: 500 });
  }
}
