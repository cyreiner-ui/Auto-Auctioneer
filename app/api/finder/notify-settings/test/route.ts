import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-auth";
import { sendTestEmail } from "@/lib/finder-notify";
import { getNotifySettings, recordNotifyAttempt } from "@/lib/finder-service";

export async function POST(request: Request) {
  if (!(await requireStaff(request))) return NextResponse.json({ error: "Staff access required." }, { status: 403 });
  const { recipients } = await getNotifySettings();
  const result = await sendTestEmail(recipients);
  await recordNotifyAttempt(result);
  if (!result.ok) return NextResponse.json({ error: result.message || "Sending the test email failed." }, { status: 502 });
  return NextResponse.json({ ok: true, recipients });
}
