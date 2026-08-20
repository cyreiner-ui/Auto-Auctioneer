"use client";

import { useState } from "react";
import Link from "next/link";

type Probe = { phrase: string; itemsReturned: number; hitResultsCap: boolean; found: boolean; matchedTitle: string | null; error: string | null };

export default function FinderDebugPanel() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [itemId, setItemId] = useState("");
  const [results, setResults] = useState<Probe[] | null>(null);

  const check = async () => {
    if (!input.trim()) return;
    setBusy(true); setError(""); setResults(null);
    try {
      const response = await fetch("/api/finder/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: input }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed.");
      setItemId(payload.itemId); setResults(payload.keywords);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(false); }
  };

  const anyFound = results?.some((probe) => probe.found);

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder">← Back to deal finder</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Finder debugger</h1><p className="muted">Check whether a specific eBay listing shows up in a live search for every enabled keyword — useful when a listing you expected the finder to catch never appeared.</p></div></header>
    <section className="panel">
      <form className="keyword-add" onSubmit={(event) => { event.preventDefault(); void check(); }}>
        <input aria-label="eBay item id or listing URL" placeholder="eBay item id or listing URL (e.g. 287535686773)" value={input} onChange={(event) => setInput(event.target.value)} />
        <button className="primary" disabled={busy}>{busy ? "Checking…" : "Check"}</button>
      </form>
      {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
      {results && <>
        <p className="muted">Item <strong>{itemId}</strong> {anyFound ? "was found" : "was NOT found"} in the live eBay search results for any enabled keyword.</p>
        <div className="keyword-list">
          {results.map((probe) => <div className="keyword-row" key={probe.phrase}>
            <span>{probe.phrase}</span>
            {probe.error
              ? <span className="muted">search failed: {probe.error}</span>
              : <span className={probe.found ? undefined : "muted"}>
                {probe.found ? `✓ found — “${probe.matchedTitle}”` : "not in results"}
                {" "}({probe.itemsReturned} item{probe.itemsReturned === 1 ? "" : "s"} returned{probe.hitResultsCap ? ", hit the per-keyword results cap — there may be more beyond what was checked" : ""})
              </span>}
          </div>)}
        </div>
      </>}
    </section>
  </main>;
}
