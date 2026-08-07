"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Result = { ebay_item_id: string; title: string; ebay_url: string; image_url: string | null; item_price: number; shipping_cost: number; total_cost: number; cost_per_knife: number; knife_count: number; buying_options: string[]; detection_source: string; discovered_at: string };
type Run = { id: string; trigger: string; status: string; keywords_scanned: number; items_seen: number; items_added: number; qualified: number; rejected: number; errors: string[]; started_at: string };
type Overview = { results: Result[]; runs: Run[]; counts: { pending: number; rejected: number; qualified: number }; settings: { zip: string; maxCostPerKnife: number } };

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const RUN_STATUS_LABEL: Record<string, string> = { running: "Working…", completed: "Done", failed: "Had a problem" };

export default function FinderDashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/finder", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load finder.");
    setData(payload); setError("");
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load().catch((reason) => setError(reason.message)), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (!data?.counts.pending && !data?.runs.some((run) => run.status === "running")) return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 15000);
    return () => window.clearInterval(timer);
  }, [data, load]);

  const request = async (url: string, init: RequestInit) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(url, init); const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed.");
      await load(); return payload;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(false); }
  };

  const archiveResult = (result: Result) => request("/api/finder/items", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ebayItemId: result.ebay_item_id, dismissed: true }) });
  const deleteResult = (result: Result) => { if (!window.confirm(`Delete "${result.title}"?`)) return; void request(`/api/finder/items?id=${encodeURIComponent(result.ebay_item_id)}`, { method: "DELETE" }); };
  const latest = data?.runs[0];

  const friendlyError = (message: string) => {
    if (message.includes("finder_") || message.includes("relation")) return "Apply the finder database migration, then reload this page.";
    const looksTechnical = /column|does not exist|violates|constraint|syntax error/i.test(message) || message.length > 160;
    return looksTechnical ? "Something went wrong. Please try again in a moment." : message;
  };

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/">← Back to staff panel</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Pocket-knife deal finder</h1><p className="muted">Daily snapshots delivered to {data?.settings.zip ?? "—"} · maximum {usd(data?.settings.maxCostPerKnife ?? 0)} per knife including shipping</p><Link className="back finder-settings-link" href="/staff/finder/settings">Search settings</Link></div><button className="primary" disabled={busy} onClick={() => void request("/api/finder/run", { method: "POST" })}>{busy ? "Working…" : "Run now"}</button></header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{friendlyError(error)}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <>
      <section className="finder-stats">
        <div><small>GOOD DEALS FOUND</small><strong>{data.counts.qualified}</strong></div><div><small>STILL CHECKING</small><strong>{data.counts.pending}</strong></div><div><small>NOT A MATCH</small><strong>{data.counts.rejected}</strong></div>
      </section>
      <section className="finder-runs"><div className="section-title"><div><p className="eyebrow">LATEST SEARCH</p><h2>{latest ? new Date(latest.started_at).toLocaleString() : "Not run yet"}</h2></div>{latest && <span className={`run-status ${latest.status}`}>{RUN_STATUS_LABEL[latest.status] || latest.status}</span>}</div>{latest && <p className="muted">Found {latest.qualified} good deal{latest.qualified === 1 ? "" : "s"} from {latest.items_added} new listing{latest.items_added === 1 ? "" : "s"}.</p>}{latest?.errors?.map((message) => <p className="finder-run-error" key={message}>{message}</p>)}</section>
      <section className="finder-results"><div className="section-title"><div><p className="eyebrow">QUALIFYING SNAPSHOTS</p><h2>Deals at or below $3.50 per knife</h2></div></div><div className="finder-grid">{data.results.map((result) => <article className="finder-card" key={result.ebay_item_id}>{result.image_url ? <img src={result.image_url} alt={result.title} /> : <div className="finder-no-image">No image</div>}<div className="finder-card-body"><div className="finder-badges"><span>{result.buying_options.includes("AUCTION") ? "Auction" : "Buy It Now"}</span><span>{result.knife_count} knives</span></div><h3>{result.title}</h3><p className="finder-price-line">{usd(result.item_price)} + {usd(result.shipping_cost)} shipping = {usd(result.total_cost)} total</p><strong className="finder-unit-price">{usd(result.cost_per_knife)} / knife</strong><p className="finder-snapshot">Price captured {new Date(result.discovered_at).toLocaleString()}. Verify the current price on eBay.</p><a className="primary" href={result.ebay_url} target="_blank" rel="noreferrer" aria-label={`View ${result.title} on eBay (opens in new tab)`}>View on eBay ↗</a><div className="finder-card-actions"><button disabled={busy} aria-label={`Archive ${result.title}`} onClick={() => void archiveResult(result)}>Archive</button><button className="danger" disabled={busy} aria-label={`Delete ${result.title}`} onClick={() => deleteResult(result)}>Delete</button></div></div></article>)}{data.results.length === 0 && <div className="empty">No qualifying snapshots yet. Run the finder or wait for the daily 6:00 AM search.</div>}</div></section>
    </>}
  </main>;
}
