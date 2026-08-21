"use client";

import { useState } from "react";
import Link from "next/link";

export default function SearchByImageProbePanel() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ status: number; approved: boolean; body: unknown } | null>(null);

  const test = async () => {
    if (!input.trim()) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/finder/debug/search-by-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl: input }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed.");
      setResult(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(false); }
  };

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder">← Back to deal finder</Link><p className="eyebrow">ONE-OFF PROBE — NOT A SHIPPED FEATURE</p><h1>searchByImage access test</h1><p className="muted">Checks whether this eBay app has production access to the limited-release searchByImage endpoint. Paste any public image URL and test.</p></div></header>
    <section className="panel">
      <form className="keyword-add" onSubmit={(event) => { event.preventDefault(); void test(); }}>
        <input aria-label="Image URL to test with" placeholder="https://... (a public image URL)" value={input} onChange={(event) => setInput(event.target.value)} />
        <button className="primary" disabled={busy}>{busy ? "Testing…" : "Test"}</button>
      </form>
      {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
      {result && <>
        <p className="muted"><strong>{result.approved ? "Approved" : "Not approved"}</strong> — eBay responded with HTTP {result.status}.</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{JSON.stringify(result.body, null, 2)}</pre>
      </>}
    </section>
  </main>;
}
