import { NextResponse } from "next/server";
import { archivedFinderItems } from "@/lib/finder-service";
import { requireStaff } from "@/lib/staff-auth";

export async function GET(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  try { return NextResponse.json(await archivedFinderItems()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load archived items." }, { status: 500 }); }
}
