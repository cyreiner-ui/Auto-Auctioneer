import { requireStaff } from "@/lib/staff-auth";
import BiddingSimulator from "./BiddingSimulator";

export const dynamic = "force-dynamic";

export default async function BiddingSimulatorPage() {
  if (!(await requireStaff())) {
    return <main className="access-screen"><div className="access-card"><strong>Staff access required</strong><p className="muted">This simulation is available only to staff users.</p></div></main>;
  }
  return <BiddingSimulator />;
}
