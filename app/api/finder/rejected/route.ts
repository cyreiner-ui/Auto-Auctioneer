import { NextResponse } from "next/server";
import { isFinderCategory, rejectedFinderItems, type FinderCategory } from "@/lib/finder-service";
import { requireStaff } from "@/lib/staff-auth";

function parseCategory(value: string | null): FinderCategory | undefined {
  return isFinderCategory(value) ? value : undefined;
}

export async function GET(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const category = parseCategory(new URL(request.url).searchParams.get("category"));
  try { return NextResponse.json(await rejectedFinderItems(category)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load rejected items." }, { status: 500 }); }
}
