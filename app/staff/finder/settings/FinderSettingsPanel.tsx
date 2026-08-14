"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Keyword = { id: string; phrase: string; enabled: boolean; max_cost_per_knife: number | null };
type Overview = { keywords: Keyword[]; budget: { mode: string; freeAnalyses: number; paidAnalyses: number; analyses: number; monthlyLimit: number; remaining: number; projectedMaximum: number; dailyAnalyses: number; dailyLimit: number; dailyRemaining: number } };

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function FinderSettingsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newPhrase, setNewPhrase] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/finder", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load finder settings.");
    setData(payload); setError("");
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load().catch((reason) => setError(reason.message)), 0); return () => window.clearTimeout(timer); }, [load]);

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
  const budgetPercent = data ? Math.min(100, Math.round((data.budget.analyses / data.budget.monthlyLimit) * 100)) : 0;
  const dailyPercent = data ? Math.min(100, Math.round((data.budget.dailyAnalyses / data.budget.dailyLimit) * 100)) : 0;

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder">← Back to deal finder</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Search settings</h1><p className="muted">Manage search terms and see usage limits.</p></div></header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <section className="finder-layout">
      <div className="panel finder-keywords"><div className="panel-heading"><div><p className="eyebrow">SEARCH TERMS</p><h2>Saved keywords</h2></div></div>
        <div className="keyword-list">{data.keywords.map((keyword) => <div className="keyword-row" key={keyword.id}><input aria-label="Keyword phrase" value={keyword.phrase} onChange={(event) => setData({ ...data, keywords: data.keywords.map((item) => item.id === keyword.id ? { ...item, phrase: event.target.value } : item) })} /><input aria-label={`Per-knife price override for "${keyword.phrase}"`} className="keyword-max-cost" type="number" step="0.01" min="0" placeholder="Default $3.50" value={keyword.max_cost_per_knife ?? ""} onChange={(event) => setData({ ...data, keywords: data.keywords.map((item) => item.id === keyword.id ? { ...item, max_cost_per_knife: event.target.value === "" ? null : Number(event.target.value) } : item) })} /><label className="keyword-toggle"><input type="checkbox" checked={keyword.enabled} onChange={(event) => void saveKeyword({ ...keyword, enabled: event.target.checked })} /> Active</label><button aria-label={`Save "${keyword.phrase}"`} disabled={busy} onClick={() => void saveKeyword(keyword)}>Save</button><button className="danger" aria-label={`Delete "${keyword.phrase}"`} disabled={busy} onClick={() => { if (window.confirm(`Delete “${keyword.phrase}”?`)) void request(`/api/finder/keywords?id=${encodeURIComponent(keyword.id)}`, { method: "DELETE" }); }}>Delete</button></div>)}</div>
        <form className="keyword-add" onSubmit={(event) => { event.preventDefault(); if (!newPhrase.trim()) return; void request("/api/finder/keywords", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phrase: newPhrase }) }).then(() => setNewPhrase("")); }}><input aria-label="Add another eBay phrase" placeholder="Add another eBay phrase" value={newPhrase} onChange={(event) => setNewPhrase(event.target.value)} /><button className="primary" disabled={busy}>Add keyword</button></form>
      </div>
      <aside className="panel finder-budget"><p className="eyebrow">MONTHLY GUARDRAIL ({data.budget.mode === "paid" ? "paid" : "free"} mode)</p><h2>{data.budget.analyses.toLocaleString()} analyses</h2><p className="muted">{data.budget.remaining.toLocaleString()} remain before the {data.budget.monthlyLimit.toLocaleString()}-analysis stop this month.</p><div className="budget-meter" role="progressbar" aria-valuenow={budgetPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly Gemini analysis budget used"><span style={{ width: `${budgetPercent}%` }} /></div><small>Conservative maximum used: {usd(data.budget.projectedMaximum)} / {usd(data.budget.monthlyLimit * 0.001)}</small>
        <div className="finder-daily-pacing"><p className="eyebrow">DAILY PACING</p><p className="muted">{data.budget.dailyAnalyses.toLocaleString()} / {data.budget.dailyLimit.toLocaleString()} analyses used today — spreads the monthly budget evenly so one busy day can&apos;t exhaust the whole month.</p><div className="budget-meter" role="progressbar" aria-valuenow={dailyPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Today's Gemini analysis pacing cap used"><span style={{ width: `${dailyPercent}%` }} /></div></div>
      </aside>
    </section>}
  </main>;
}
