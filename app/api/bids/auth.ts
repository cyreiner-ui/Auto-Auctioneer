import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";

export async function staffOnly(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  return null;
}
