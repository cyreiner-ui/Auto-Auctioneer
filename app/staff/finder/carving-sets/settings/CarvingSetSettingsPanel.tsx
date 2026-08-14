"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Keyword = { id: string; phrase: string; enabled: boolean };
type NotifyRecipient = { id: string; email: string; created_at: string };
type NotifySettings = { mode: "auctions_only" | "all_qualified"; recipients: NotifyRecipient[]; usingEnvFallback: boolean };
type Overview = { keywords: Keyword[]; notify: NotifySettings; budget: { mode: string; freeAnalyses: number; paidAnalyses: number; analyses: number; monthlyLimit: number; remaining: number; projectedMaximum: number; dailyAnalyses: number; dailyLimit: number; dailyRemaining: number } };

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function CarvingSetSettingsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newRecipientEmail, setNewRecipientEmail] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/finder?category=carving_set", { cache: "no-store" });
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

  const setEnabled = (keyword: Keyword, enabled: boolean) => request("/api/finder/keywords", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: keyword.id, enabled }) });
  const saveMode = (mode: string) => request("/api/finder/notify-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  const budgetPercent = data ? Math.min(100, Math.round((data.budget.analyses / data.budget.monthlyLimit) * 100)) : 0;
  const dailyPercent = data ? Math.min(100, Math.round((data.budget.dailyAnalyses / data.budget.dailyLimit) * 100)) : 0;

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder/carving-sets">← Back to carving-set finder</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Carving-set search settings</h1><p className="muted">These two search terms are tied to fixed pricing rules in code (Sheffield $200 flat/carbon steel only, German $10/piece + $15) — enable or disable them here, but the phrase text and pricing aren&apos;t editable from this page.</p></div></header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <section className="finder-layout">
      <div className="panel finder-keywords"><div className="panel-heading"><div><p className="eyebrow">SEARCH TERMS</p><h2>Carving-set keywords</h2></div></div>
        <div className="keyword-list">{data.keywords.map((keyword) => <div className="keyword-row" key={keyword.id}><span>{keyword.phrase}</span><label className="keyword-toggle"><input type="checkbox" checked={keyword.enabled} disabled={busy} onChange={(event) => void setEnabled(keyword, event.target.checked)} /> Active</label></div>)}</div>
      </div>
      <aside className="panel finder-budget"><p className="eyebrow">MONTHLY GUARDRAIL ({data.budget.mode === "paid" ? "paid" : "free"} mode)</p><h2>{data.budget.analyses.toLocaleString()} analyses</h2><p className="muted">{data.budget.remaining.toLocaleString()} remain before the {data.budget.monthlyLimit.toLocaleString()}-analysis stop this month. This budget is shared with the pocket-knife finder.</p><div className="budget-meter" role="progressbar" aria-valuenow={budgetPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly Gemini analysis budget used"><span style={{ width: `${budgetPercent}%` }} /></div><small>Conservative maximum used: {usd(data.budget.projectedMaximum)} / {usd(data.budget.monthlyLimit * 0.001)}</small>
        <div className="finder-daily-pacing"><p className="eyebrow">DAILY PACING</p><p className="muted">{data.budget.dailyAnalyses.toLocaleString()} / {data.budget.dailyLimit.toLocaleString()} analyses used today.</p><div className="budget-meter" role="progressbar" aria-valuenow={dailyPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Today's Gemini analysis pacing cap used"><span style={{ width: `${dailyPercent}%` }} /></div></div>
      </aside>
      <div className="panel finder-notify">
        <div className="panel-heading"><div><p className="eyebrow">EMAIL ALERTS</p><h2>Notification settings</h2></div></div>
        <p className="muted">Shared with the pocket-knife finder — one recipient list and mode for both, but carving-set deals always go out in their own separate email.</p>
        <fieldset className="notify-mode">
          <legend className="visually-hidden">When to send alert emails</legend>
          <label><input type="radio" name="notify-mode" checked={data.notify.mode === "auctions_only"} disabled={busy} onChange={() => void saveMode("auctions_only")} /> Detailed email for new auctions only (default)</label>
          <label><input type="radio" name="notify-mode" checked={data.notify.mode === "all_qualified"} disabled={busy} onChange={() => void saveMode("all_qualified")} /> Summary email whenever any new result is found (auctions + fixed-price)</label>
        </fieldset>
        {data.notify.usingEnvFallback && <p className="muted">No recipients saved yet — falling back to FINDER_ALERT_EMAILS.</p>}
        <div className="keyword-list notify-recipient-list">{data.notify.recipients.map((recipient) => <div className="keyword-row notify-recipient-row" key={recipient.id}><span>{recipient.email}</span><button className="danger" aria-label={`Remove ${recipient.email}`} disabled={busy} onClick={() => { if (window.confirm(`Remove ${recipient.email}?`)) void request(`/api/finder/notify-settings?id=${encodeURIComponent(recipient.id)}`, { method: "DELETE" }); }}>Remove</button></div>)}</div>
        <form className="keyword-add notify-recipient-add" onSubmit={(event) => { event.preventDefault(); if (!newRecipientEmail.trim()) return; void request("/api/finder/notify-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: newRecipientEmail }) }).then(() => setNewRecipientEmail("")); }}><input aria-label="Add a recipient email" type="email" placeholder="Add a recipient email" value={newRecipientEmail} onChange={(event) => setNewRecipientEmail(event.target.value)} /><button className="primary" disabled={busy}>Add recipient</button></form>
      </div>
    </section>}
  </main>;
}
