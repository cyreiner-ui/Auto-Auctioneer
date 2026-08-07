import { requireStaff } from "@/lib/staff-auth";
import FinderSettingsPanel from "./FinderSettingsPanel";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function FinderSettingsPage() {
  if (!(await requireStaff())) return <main className="access-screen"><div className="access-card"><strong>Staff access required</strong><p className="muted">Open the main app and enter the staff password before using the eBay finder.</p><Link className="primary" href="/">Return to sign in</Link></div></main>;
  return <FinderSettingsPanel />;
}
