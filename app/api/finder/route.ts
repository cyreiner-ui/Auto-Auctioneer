import { NextResponse } from "next/server";
import { finderOverview } from "@/lib/finder-service";
import { requireStaff } from "@/lib/staff-auth";

export async function GET(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  try { return NextResponse.json(await finderOverview()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Finder data is unavailable." }, { status: 500 }); }
}
