import { requireStaff } from "@/lib/staff-auth";
import CarvingSetDashboard from "./CarvingSetDashboard";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CarvingSetFinderPage() {
  if (!(await requireStaff())) return <main className="access-screen"><div className="access-card"><strong>Staff access required</strong><p className="muted">Open the main app and enter the staff password before using the eBay finder.</p><Link className="primary" href="/">Return to sign in</Link></div></main>;
  return <CarvingSetDashboard />;
}
