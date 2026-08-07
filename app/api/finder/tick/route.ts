import { NextResponse } from "next/server";
import { finderTick } from "@/lib/finder-service";
import { isSchedulerRequest } from "@/lib/scheduler-auth";
import { requireStaff } from "@/lib/staff-auth";

export async function POST(request: Request) {
  if (!isSchedulerRequest(request.headers) && !(await requireStaff(request))) return NextResponse.json({ error: "Staff or scheduler access required." }, { status: 403 });
  try { return NextResponse.json(await finderTick()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Finder tick failed." }, { status: 500 }); }
}

export async function GET(request: Request) { return POST(request); }
