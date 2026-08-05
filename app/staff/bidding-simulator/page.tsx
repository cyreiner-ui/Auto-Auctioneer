import { requireStaff } from "@/lib/staff-auth";
import { notFound } from "next/navigation";
import BiddingSimulator from "./BiddingSimulator";

export const dynamic = "force-dynamic";

export default async function BiddingSimulatorPage() {
  if (process.env.NEXT_PUBLIC_BIDDING_UI_ENABLED !== "true") notFound();
  if (!(await requireStaff())) {
    return <main className="access-screen"><div className="access-card"><strong>Staff access required</strong><p className="muted">This simulation is available only to staff users.</p></div></main>;
  }
  return <BiddingSimulator />;
}
