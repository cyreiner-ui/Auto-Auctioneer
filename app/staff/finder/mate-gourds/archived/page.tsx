import { requireStaff } from "@/lib/staff-auth";
import MateGourdArchivedPanel from "./MateGourdArchivedPanel";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function MateGourdArchivedPage() {
  if (!(await requireStaff())) return <main className="access-screen"><div className="access-card"><strong>Staff access required</strong><p className="muted">Open the main app and enter the staff password before using the eBay finder.</p><Link className="primary" href="/">Return to sign in</Link></div></main>;
  return <MateGourdArchivedPanel />;
}
