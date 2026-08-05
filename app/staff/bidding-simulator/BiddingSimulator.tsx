"use client";

import { useMemo, useState } from "react";

type MockStatus = "scheduled" | "open" | "confirming" | "submitted" | "expired";
type MockLot = { id: string; title: string; endIn: number; maxBid: number; status: MockStatus };
type AuditEvent = { id: number; lotId: string; message: string };

const initialLots: MockLot[] = [
  { id: "SIM-101", title: "Mock vintage knife", endIn: 90, maxBid: 125, status: "scheduled" },
  { id: "SIM-102", title: "Mock collector lot", endIn: 35, maxBid: 210, status: "scheduled" },
  { id: "SIM-103", title: "Mock signed display", endIn: 8, maxBid: 80, status: "scheduled" },
];

export default function BiddingSimulator() {
  const [clock, setClock] = useState(0);
  const [lots, setLots] = useState(initialLots);
  const [selectedId, setSelectedId] = useState(initialLots[0].id);
  const [enteredBid, setEnteredBid] = useState(String(initialLots[0].maxBid));
  const [audit, setAudit] = useState<AuditEvent[]>([{ id: 1, lotId: "SYSTEM", message: "Simulation started. No external requests are made." }]);
  const selected = lots.find((lot) => lot.id === selectedId) || lots[0];
  const remaining = selected.endIn - clock;
  const canOpen = selected.status === "scheduled" && remaining > 0;
  const canPlace = selected.status === "open" && remaining > 0;
  const statusLabel = useMemo(() => ({ scheduled: "Scheduled", open: "Mock page open", confirming: "Confirmation required", submitted: "Simulated bid accepted", expired: "Expired" }[selected.status]), [selected.status]);

  const addAudit = (message: string, lotId = selected.id) => setAudit((events) => [{ id: Date.now(), lotId, message }, ...events].slice(0, 12));
  const advance = (seconds: number) => { const nextClock = clock + seconds; setClock(nextClock); setLots((current) => current.map((lot) => lot.status === "scheduled" && lot.endIn - nextClock <= 0 ? { ...lot, status: "expired" } : lot)); addAudit(`Simulation clock advanced by ${seconds} seconds.`); };
  const selectLot = (id: string) => { const lot = lots.find((item) => item.id === id) || lots[0]; setSelectedId(id); setEnteredBid(String(lot.maxBid)); };
  const openAuction = () => { if (!canOpen) return; setLots((current) => current.map((lot) => lot.id === selected.id ? { ...lot, status: "open" } : lot)); addAudit("Mock auction page opened."); };
  const placeBid = () => { if (!canPlace || Number(enteredBid) <= 0) return; setLots((current) => current.map((lot) => lot.id === selected.id ? { ...lot, status: "confirming" } : lot)); addAudit("Mock Place Bid clicked; confirmation is required."); };
  const confirmBid = () => { if (selected.status !== "confirming") return; setLots((current) => current.map((lot) => lot.id === selected.id ? { ...lot, status: "submitted" } : lot)); addAudit(`Mock confirmation accepted at ${enteredBid}.`); };
  const reset = () => { setClock(0); setLots(initialLots); setSelectedId(initialLots[0].id); setEnteredBid(String(initialLots[0].maxBid)); setAudit([{ id: Date.now(), lotId: "SYSTEM", message: "Simulation reset." }]); };

  return <main className="simulator-page"><div className="simulator-header"><div><p className="eyebrow">STAFF ONLY · SAFE DEMO</p><h1>Bidding automation simulator</h1><p className="muted">This is a fake auction environment. It never contacts eBay or submits a real bid.</p></div><span className="simulation-badge">SIMULATION ONLY</span></div><div className="simulator-toolbar"><strong>Clock: +{clock}s</strong><button className="secondary-access" onClick={() => advance(10)}>Advance 10s</button><button className="secondary-access" onClick={() => advance(30)}>Advance 30s</button><button className="danger" onClick={reset}>Reset</button></div><div className="simulator-grid"><section className="panel simulator-lots"><div className="panel-heading"><div><p className="eyebrow">MOCK QUEUE</p><h2>{lots.length} lots</h2></div></div>{lots.map((lot) => <button className={`sim-lot ${lot.id === selected.id ? "selected" : ""}`} key={lot.id} onClick={() => selectLot(lot.id)}><span><strong>{lot.title}</strong><small>{lot.id}</small></span><span><strong>{lot.endIn - clock > 0 ? `${lot.endIn - clock}s` : "ended"}</strong><small>{lot.status}</small></span></button>)}</section><section className="panel simulator-workspace"><div className="simulator-warning"><strong>Offline mock page</strong><span>All bid controls below are simulated.</span></div><p className="eyebrow">{selected.id}</p><h2>{selected.title}</h2><div className="sim-stats"><div><small>Time remaining</small><strong>{remaining > 0 ? `${remaining}s` : "Ended"}</strong></div><div><small>Maximum bid</small><strong>${selected.maxBid.toFixed(2)}</strong></div><div><small>Status</small><strong>{statusLabel}</strong></div></div>{selected.status === "confirming" ? <div className="sim-confirm"><p>Mock confirmation modal</p><strong>Confirm bid of ${Number(enteredBid || 0).toFixed(2)}?</strong><button className="primary" onClick={confirmBid}>Confirm simulated bid</button></div> : <><label>Mock bid amount<input type="number" min="0.01" step="0.01" value={enteredBid} onChange={(event) => setEnteredBid(event.target.value)} disabled={!canPlace} /></label><div className="sim-actions"><button className="primary" onClick={openAuction} disabled={!canOpen}>Open mock auction</button><button className="approve" onClick={placeBid} disabled={!canPlace}>Place simulated bid</button></div></>}{selected.status === "submitted" && <p className="notice">Simulated bid accepted. Duplicate submission is blocked.</p>}{selected.status === "expired" && <p className="access-error">This mock auction has expired.</p>}</section><section className="panel simulator-audit"><div className="panel-heading"><div><p className="eyebrow">AUDIT LOG</p><h2>Events</h2></div></div><div className="sim-audit-list">{audit.map((event) => <div key={event.id}><small>{event.lotId}</small><span>{event.message}</span></div>)}</div></section></div></main>;
}
