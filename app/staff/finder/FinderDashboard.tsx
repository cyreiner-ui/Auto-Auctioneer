"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Keyword = { id: string; phrase: string; enabled: boolean };
type Result = { ebay_item_id: string; title: string; ebay_url: string; image_url: string | null; item_price: number; shipping_cost: number; total_cost: number; cost_per_knife: number; knife_count: number; buying_options: string[]; detection_source: string; discovered_at: string };
type Run = { id: string; trigger: string; status: string; keywords_scanned: number; items_seen: number; items_added: number; qualified: number; rejected: number; errors: string[]; started_at: string };
type Overview = { keywords: Keyword[]; results: Result[]; runs: Run[]; counts: { pending: number; rejected: number; qualified: number }; budget: { mode: string; paidAnalyses: number; monthlyLimit: number; remaining: number; projectedMaximum: number } };

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function FinderDashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newPhrase, setNewPhrase] = useState("");

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

  const saveKeyword = (keyword: Keyword) => request("/api/finder/keywords", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(keyword) });
  const latest = data?.runs[0];

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/">← Back to staff panel</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Pocket-knife deal finder</h1><p className="muted">Daily snapshots delivered to 32819 · maximum {usd(3.5)} per knife including shipping</p></div><button className="primary" disabled={busy} onClick={() => void request("/api/finder/run", { method: "POST" })}>{busy ? "Working…" : "Run now"}</button></header>
    {error && <div className="notice finder-error">{error.includes("finder_") || error.includes("relation") ? "Apply the finder database migration, then reload this page." : error}</div>}
    {data && <>
      <section className="finder-stats">
        <div><small>QUALIFYING</small><strong>{data.counts.qualified}</strong></div><div><small>WAITING FOR ANALYSIS</small><strong>{data.counts.pending}</strong></div><div><small>FILTERED OUT</small><strong>{data.counts.rejected}</strong></div><div><small>VISION MODE</small><strong>{data.budget.mode}</strong></div>
      </section>
      <section className="finder-layout">
        <div className="panel finder-keywords"><div className="panel-heading"><div><p className="eyebrow">SEARCH TERMS</p><h2>Saved keywords</h2></div></div>
          <div className="keyword-list">{data.keywords.map((keyword) => <div className="keyword-row" key={keyword.id}><input aria-label="Keyword phrase" value={keyword.phrase} onChange={(event) => setData({ ...data, keywords: data.keywords.map((item) => item.id === keyword.id ? { ...item, phrase: event.target.value } : item) })} /><label className="keyword-toggle"><input type="checkbox" checked={keyword.enabled} onChange={(event) => void saveKeyword({ ...keyword, enabled: event.target.checked })} /> Active</label><button disabled={busy} onClick={() => void saveKeyword(keyword)}>Save</button><button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Delete “${keyword.phrase}”?`)) void request(`/api/finder/keywords?id=${encodeURIComponent(keyword.id)}`, { method: "DELETE" }); }}>Delete</button></div>)}</div>
          <form className="keyword-add" onSubmit={(event) => { event.preventDefault(); if (!newPhrase.trim()) return; void request("/api/finder/keywords", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phrase: newPhrase }) }).then(() => setNewPhrase("")); }}><input placeholder="Add another eBay phrase" value={newPhrase} onChange={(event) => setNewPhrase(event.target.value)} /><button className="primary" disabled={busy}>Add keyword</button></form>
        </div>
        <aside className="panel finder-budget"><p className="eyebrow">MONTHLY GUARDRAIL</p><h2>{data.budget.mode === "paid" ? `${data.budget.paidAnalyses.toLocaleString()} analyses` : "Free tier"}</h2><p className="muted">{data.budget.mode === "paid" ? `${data.budget.remaining.toLocaleString()} remain before the 50,000-analysis stop.` : "If Gemini reaches the free limit, new items stay queued for a later run."}</p><div className="budget-meter"><span style={{ width: `${Math.min(100, data.budget.paidAnalyses / data.budget.monthlyLimit * 100)}%` }} /></div><small>Conservative maximum used: {usd(data.budget.projectedMaximum)} / $50.00</small></aside>
      </section>
      <section className="finder-runs"><div className="section-title"><div><p className="eyebrow">LATEST SEARCH</p><h2>{latest ? new Date(latest.started_at).toLocaleString() : "Not run yet"}</h2></div>{latest && <span className={`run-status ${latest.status}`}>{latest.status}</span>}</div>{latest && <p className="muted">{latest.keywords_scanned} keywords · {latest.items_seen} results scanned · {latest.items_added} new · {latest.qualified} qualifying · {latest.rejected} filtered</p>}{latest?.errors?.map((message) => <p className="finder-run-error" key={message}>{message}</p>)}</section>
      <section className="finder-results"><div className="section-title"><div><p className="eyebrow">QUALIFYING SNAPSHOTS</p><h2>Deals at or below $3.50 per knife</h2></div></div><div className="finder-grid">{data.results.map((result) => <article className="finder-card" key={result.ebay_item_id}>{result.image_url ? <img src={result.image_url} alt={result.title} /> : <div className="finder-no-image">No image</div>}<div className="finder-card-body"><div className="finder-badges"><span>{result.buying_options.includes("AUCTION") ? "Auction" : "Buy It Now"}</span><span>{result.knife_count} knives</span></div><h3>{result.title}</h3><dl><div><dt>Item</dt><dd>{usd(result.item_price)}</dd></div><div><dt>Shipping</dt><dd>{usd(result.shipping_cost)}</dd></div><div><dt>Total</dt><dd>{usd(result.total_cost)}</dd></div></dl><strong className="finder-unit-price">{usd(result.cost_per_knife)} / knife</strong><p className="finder-snapshot">Price captured {new Date(result.discovered_at).toLocaleString()}. Verify the current price on eBay.</p><a className="primary" href={result.ebay_url} target="_blank" rel="noreferrer">View on eBay ↗</a></div></article>)}{data.results.length === 0 && <div className="empty">No qualifying snapshots yet. Run the finder or wait for the daily 6:00 AM search.</div>}</div></section>
    </>}
  </main>;
}
