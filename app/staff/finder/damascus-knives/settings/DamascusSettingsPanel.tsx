"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Keyword = { id: string; phrase: string; enabled: boolean };
type NotifyRecipient = { id: string; email: string; created_at: string };
type NotifySettings = { mode: "auctions_only" | "all_qualified"; recipients: NotifyRecipient[]; usingEnvFallback: boolean; lastAttemptAt: string | null; lastError: string | null; lastSuccessAt: string | null };
type Schedule = { enabled: boolean; frequency: "daily" | "weekly"; hour: number; minute: number; dayOfWeek: number | null; extraRunHours: number[] };
type NegativeKeyword = { id: string; phrase: string; enabled: boolean };
type Overview = { keywords: Keyword[]; negativeKeywords: NegativeKeyword[]; notify: NotifySettings; schedule: Schedule; processingPaused: boolean; budget: { mode: string; freeAnalyses: number; paidAnalyses: number; analyses: number; monthlyLimit: number; remaining: number; projectedMaximum: number; dailyAnalyses: number; dailyLimit: number; dailyRemaining: number; geminiApiKeyPreview: string | null }; settings: { damascusMaxCostPerKnife: number; damascusKitchenMaxCostPerKnife: number } };

const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function DamascusSettingsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newPhrase, setNewPhrase] = useState("");
  const [newNegativePhrase, setNewNegativePhrase] = useState("");
  const [newRecipientEmail, setNewRecipientEmail] = useState("");
  const [maxCostInput, setMaxCostInput] = useState("");
  const [kitchenMaxCostInput, setKitchenMaxCostInput] = useState("");
  const [extraRunHoursInput, setExtraRunHoursInput] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/finder?category=damascus_knife", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load finder settings.");
    setData(payload); setMaxCostInput(String(payload.settings.damascusMaxCostPerKnife)); setKitchenMaxCostInput(String(payload.settings.damascusKitchenMaxCostPerKnife));
    setExtraRunHoursInput((payload.schedule.extraRunHours as number[]).join(", "));
    setError("");
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

  const sendTestEmail = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/finder/notify-settings/test", { method: "POST" });
      const payload = await response.json();
      await load();
      if (!response.ok) throw new Error(payload.error || "Sending the test email failed.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sending the test email failed."); }
    finally { setBusy(false); }
  };

  const saveKeyword = (keyword: Keyword) => {
    if (!/\bdamascus\b/i.test(keyword.phrase)) { setError("Damascus search terms must include the word \"damascus\"."); return; }
    return request("/api/finder/keywords", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(keyword) });
  };
  const setNegativeEnabled = (keyword: NegativeKeyword, enabled: boolean) => request("/api/finder/damascus-negative-keywords", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: keyword.id, enabled }) });
  const saveMode = (mode: string) => request("/api/finder/notify-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  const saveSchedule = (patch: Partial<Schedule>) => request("/api/finder/schedule", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "damascus_knife", ...patch }) });
  const saveExtraRunHours = (event: FormEvent) => {
    event.preventDefault();
    const hours = extraRunHoursInput.split(",").map((part) => part.trim()).filter(Boolean).map(Number);
    if (hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) { setError("Additional run hours must be whole numbers between 0 and 23, comma-separated."); return; }
    void saveSchedule({ extraRunHours: [...new Set(hours)] });
  };
  const setProcessingPaused = (paused: boolean) => request("/api/finder/processing-paused", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "damascus_knife", paused }) });
  const saveMaxCosts = (event: FormEvent) => { event.preventDefault(); void request("/api/finder/damascus-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_cost_per_knife: maxCostInput, kitchen_max_cost_per_knife: kitchenMaxCostInput }) }); };
  // Any phrase containing "damascus" is routed to this finder (see keywordCategory in
  // lib/finder-service.ts); anything else would silently land in the pocket-knife finder instead.
  const addKeyword = (event: FormEvent) => {
    event.preventDefault();
    if (!newPhrase.trim()) return;
    if (!/\bdamascus\b/i.test(newPhrase)) { setError("Damascus search terms must include the word \"damascus\" — otherwise they'd be searched by the pocket-knife finder instead."); return; }
    void request("/api/finder/keywords", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phrase: newPhrase }) }).then(() => setNewPhrase(""));
  };
  const budgetPercent = data ? Math.min(100, Math.round((data.budget.analyses / data.budget.monthlyLimit) * 100)) : 0;
  const dailyPercent = data ? Math.min(100, Math.round((data.budget.dailyAnalyses / data.budget.dailyLimit) * 100)) : 0;

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder">← Back to deal finder</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Damascus knife search settings</h1><p className="muted">Damascus-steel pocket, bowie, and kitchen/chef knives. Kitchen/chef knives have their own per-knife ceiling; every other knife uses the standard one. A mixed lot qualifies when its total fits the sum of each knife&apos;s own ceiling. Sets and lots are processed and listed first.</p></div></header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <section className="finder-layout">
      <div className="panel finder-keywords"><div className="panel-heading"><div><p className="eyebrow">SEARCH TERMS</p><h2>Saved keywords</h2></div></div>
        <form className="keyword-add" onSubmit={saveMaxCosts}>
          <label>Max cost per knife (pocket, bowie, other)
            <input aria-label="Max cost per knife" type="number" step="0.01" min="0.01" value={maxCostInput} onChange={(event) => setMaxCostInput(event.target.value)} />
          </label>
          <label>Max cost per kitchen/chef knife
            <input aria-label="Max cost per kitchen or chef knife" type="number" step="0.01" min="0.01" value={kitchenMaxCostInput} onChange={(event) => setKitchenMaxCostInput(event.target.value)} />
          </label>
          <button className="primary" disabled={busy}>Save prices</button>
        </form>
        <p className="muted">Currently {usd(data.settings.damascusMaxCostPerKnife)} per knife, {usd(data.settings.damascusKitchenMaxCostPerKnife)} per kitchen/chef knife, including shipping. New search terms must include the word &ldquo;damascus&rdquo;.</p>
        <div className="keyword-list">{data.keywords.map((keyword) => <div className="keyword-row" key={keyword.id}><input aria-label="Keyword phrase" value={keyword.phrase} onChange={(event) => setData({ ...data, keywords: data.keywords.map((item) => item.id === keyword.id ? { ...item, phrase: event.target.value } : item) })} /><label className="keyword-toggle"><input type="checkbox" checked={keyword.enabled} onChange={(event) => void saveKeyword({ ...keyword, enabled: event.target.checked })} /> Active</label><button aria-label={`Save "${keyword.phrase}"`} disabled={busy} onClick={() => void saveKeyword(keyword)}>Save</button><button className="danger" aria-label={`Delete "${keyword.phrase}"`} disabled={busy} onClick={() => { if (window.confirm(`Delete “${keyword.phrase}”?`)) void request(`/api/finder/keywords?id=${encodeURIComponent(keyword.id)}`, { method: "DELETE" }); }}>Delete</button></div>)}</div>
        <form className="keyword-add" onSubmit={addKeyword}><input aria-label="Add another eBay phrase" placeholder="e.g. damascus hunting knife lot" value={newPhrase} onChange={(event) => setNewPhrase(event.target.value)} /><button className="primary" disabled={busy}>Add keyword</button></form>
      </div>
      <div className="panel finder-keywords"><div className="panel-heading"><div><p className="eyebrow">FILTER OUT</p><h2>Negative keywords</h2></div></div>
        <p className="muted">Checked against every candidate&apos;s title/description before it&apos;s classified — a match rejects the listing outright, even one that would otherwise qualify (e.g. by a recognized brand name). Kept deliberately narrow, since a term here can hide a genuine listing if it&rsquo;s too broad.</p>
        <div className="keyword-list">{data.negativeKeywords.map((keyword) => <div className="keyword-row" key={keyword.id}><span>{keyword.phrase}</span><label className="keyword-toggle"><input type="checkbox" checked={keyword.enabled} disabled={busy} onChange={(event) => void setNegativeEnabled(keyword, event.target.checked)} /> Active</label><button className="danger" aria-label={`Delete "${keyword.phrase}"`} disabled={busy} onClick={() => { if (window.confirm(`Delete "${keyword.phrase}"?`)) void request(`/api/finder/damascus-negative-keywords?id=${encodeURIComponent(keyword.id)}`, { method: "DELETE" }); }}>Delete</button></div>)}</div>
        <form className="keyword-add" onSubmit={(event) => { event.preventDefault(); if (!newNegativePhrase.trim()) return; void request("/api/finder/damascus-negative-keywords", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phrase: newNegativePhrase }) }).then(() => setNewNegativePhrase("")); }}><input aria-label="Add a negative keyword" placeholder="Add a negative keyword" value={newNegativePhrase} onChange={(event) => setNewNegativePhrase(event.target.value)} /><button className="primary" disabled={busy}>Add</button></form>
      </div>
      <aside className="panel finder-budget"><p className="eyebrow">MONTHLY GUARDRAIL ({data.budget.mode === "paid" ? "paid" : "free"} mode)</p><h2>{data.budget.analyses.toLocaleString()} analyses</h2><p className="muted">{data.budget.remaining.toLocaleString()} remain before the {data.budget.monthlyLimit.toLocaleString()}-analysis stop this month.</p><div className="budget-meter" role="progressbar" aria-valuenow={budgetPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly Gemini analysis budget used"><span style={{ width: `${budgetPercent}%` }} /></div><small>Conservative maximum used: {usd(data.budget.projectedMaximum)} / {usd(data.budget.monthlyLimit * 0.001)}</small>
        <p className="muted"><small>{data.budget.mode} mode logged this month: {data.budget.freeAnalyses.toLocaleString()} free / {data.budget.paidAnalyses.toLocaleString()} paid. GEMINI_PAID_MODE only changes which of those two counters an analysis is logged under — it has no effect on Gemini&apos;s actual rate limit. If analyses keep landing as &quot;free&quot; while you expect paid-tier limits, the deployed API key ({data.budget.geminiApiKeyPreview ?? "not configured"}) likely isn&apos;t the one on your billing-enabled Google Cloud project — check it against Google AI Studio / Cloud Console.</small></p>
        <div className="finder-daily-pacing"><p className="eyebrow">DAILY PACING</p><p className="muted">{data.budget.dailyAnalyses.toLocaleString()} / {data.budget.dailyLimit.toLocaleString()} analyses used today — spreads the monthly budget evenly so one busy day can&apos;t exhaust the whole month.</p><div className="budget-meter" role="progressbar" aria-valuenow={dailyPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Today's Gemini analysis pacing cap used"><span style={{ width: `${dailyPercent}%` }} /></div></div>
      </aside>
      <div className="panel finder-schedule">
        <div className="panel-heading"><div><p className="eyebrow">AUTOMATION</p><h2>Automatic scan schedule</h2></div></div>
        <label className="keyword-toggle"><input type="checkbox" checked={data.schedule.enabled} disabled={busy} onChange={(event) => void saveSchedule({ enabled: event.target.checked })} /> Run automatically</label>
        <label className="keyword-toggle"><input type="checkbox" checked={data.processingPaused} disabled={busy} onChange={(event) => void setProcessingPaused(event.target.checked)} /> Pause processing</label>
        {data.processingPaused && <p className="muted">Pending Damascus candidates wait as-is — no Gemini calls or eBay lookups run for this track until this is turned back off. New candidates from the scan above still keep arriving; they just wait too.</p>}
        <div className="schedule-controls">
          <label>Frequency
            <select value={data.schedule.frequency} disabled={busy} onChange={(event) => void saveSchedule({ frequency: event.target.value as Schedule["frequency"] })}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          {data.schedule.frequency === "weekly" && <label>Day
            <select value={data.schedule.dayOfWeek ?? 0} disabled={busy} onChange={(event) => void saveSchedule({ dayOfWeek: Number(event.target.value) })}>
              {WEEKDAY_LABEL.map((label, index) => <option key={label} value={index}>{label}</option>)}
            </select>
          </label>}
          <label>Time (Eastern)
            <input type="time" disabled={busy} value={`${String(data.schedule.hour).padStart(2, "0")}:${String(data.schedule.minute).padStart(2, "0")}`} onChange={(event) => { const [hour, minute] = event.target.value.split(":").map(Number); if (Number.isInteger(hour) && Number.isInteger(minute)) void saveSchedule({ hour, minute }); }} />
          </label>
        </div>
        <form className="keyword-add" onSubmit={saveExtraRunHours}>
          <label>Additional run hours (Eastern, comma-separated, 0-23)
            <input aria-label="Additional run hours" placeholder="e.g. 14, 22" disabled={busy} value={extraRunHoursInput} onChange={(event) => setExtraRunHoursInput(event.target.value)} />
          </label>
          <button className="primary" disabled={busy}>Save additional hours</button>
        </form>
        <p className="muted">Runs at the time above, plus any additional hours listed (same minute each time) — e.g. 7, 15 runs the scan twice a day. Leave blank to run only once a day/week. Scheduled independently from the other finders&apos; automatic scans.</p>
      </div>
      <div className="panel finder-notify">
        <div className="panel-heading"><div><p className="eyebrow">EMAIL ALERTS</p><h2>Notification settings</h2></div></div>
        <fieldset className="notify-mode">
          <legend className="visually-hidden">When to send alert emails</legend>
          <label><input type="radio" name="notify-mode" checked={data.notify.mode === "auctions_only"} disabled={busy} onChange={() => void saveMode("auctions_only")} /> Detailed email for new auctions only (default)</label>
          <label><input type="radio" name="notify-mode" checked={data.notify.mode === "all_qualified"} disabled={busy} onChange={() => void saveMode("all_qualified")} /> Summary email whenever any new result is found (auctions + fixed-price)</label>
        </fieldset>
        {data.notify.usingEnvFallback && <p className="muted">No recipients saved yet — falling back to FINDER_ALERT_EMAILS.</p>}
        <div className="keyword-list notify-recipient-list">{data.notify.recipients.map((recipient) => <div className="keyword-row notify-recipient-row" key={recipient.id}><span>{recipient.email}</span><button className="danger" aria-label={`Remove ${recipient.email}`} disabled={busy} onClick={() => { if (window.confirm(`Remove ${recipient.email}?`)) void request(`/api/finder/notify-settings?id=${encodeURIComponent(recipient.id)}`, { method: "DELETE" }); }}>Remove</button></div>)}</div>
        <form className="keyword-add notify-recipient-add" onSubmit={(event) => { event.preventDefault(); if (!newRecipientEmail.trim()) return; void request("/api/finder/notify-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: newRecipientEmail }) }).then(() => setNewRecipientEmail("")); }}><input aria-label="Add a recipient email" type="email" placeholder="Add a recipient email" value={newRecipientEmail} onChange={(event) => setNewRecipientEmail(event.target.value)} /><button className="primary" disabled={busy}>Add recipient</button></form>
        <div className="notify-status">
          {data.notify.lastError && <p className="notice finder-error" role="status">Last alert email attempt failed{data.notify.lastAttemptAt ? ` (${new Date(data.notify.lastAttemptAt).toLocaleString()})` : ""}: {data.notify.lastError}</p>}
          {!data.notify.lastError && data.notify.lastSuccessAt && <p className="muted">Last alert email sent successfully at {new Date(data.notify.lastSuccessAt).toLocaleString()}.</p>}
          {!data.notify.lastAttemptAt && <p className="muted">No alert email has been attempted yet.</p>}
          <button type="button" disabled={busy} onClick={() => void sendTestEmail()}>Send test email</button>
        </div>
      </div>
    </section>}
  </main>;
}
