"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Keyword = { id: string; phrase: string; enabled: boolean };
type ReferenceImage = { id: string; label: string | null; signedUrl: string | null };
type NotifyRecipient = { id: string; email: string; created_at: string };
type NotifySettings = { mode: "auctions_only" | "all_qualified"; recipients: NotifyRecipient[]; usingEnvFallback: boolean };
type Schedule = { enabled: boolean; frequency: "daily" | "weekly"; hour: number; minute: number; dayOfWeek: number | null };
type Overview = {
  keywords: Keyword[]; negativeKeywords: Keyword[]; referenceImages: ReferenceImage[];
  notify: NotifySettings; schedule: Schedule;
  budget: { mode: string; analyses: number; monthlyLimit: number; remaining: number; projectedMaximum: number; dailyAnalyses: number; dailyLimit: number };
  settings: { gauchoKeywordSearchEnabled: boolean };
};

const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function GauchoKnifeSettingsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newPhrase, setNewPhrase] = useState("");
  const [newNegativePhrase, setNewNegativePhrase] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const [newRecipientEmail, setNewRecipientEmail] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/finder?category=gaucho_knife", { cache: "no-store" });
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

  const setKeywordEnabled = (keyword: Keyword, enabled: boolean) => request("/api/finder/keywords", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: keyword.id, enabled }) });
  const setNegativeEnabled = (keyword: Keyword, enabled: boolean) => request("/api/finder/gaucho-negative-keywords", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: keyword.id, enabled }) });
  const saveMode = (mode: string) => request("/api/finder/notify-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  const saveSchedule = (patch: Partial<Schedule>) => request("/api/finder/schedule", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "gaucho_knife", ...patch }) });
  const setKeywordSearchEnabled = (enabled: boolean) => request("/api/finder/gaucho-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyword_search_enabled: enabled }) });

  const uploadReferenceImage = async (file: File) => {
    setUploading(true); setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("label", newLabel);
      const response = await fetch("/api/finder/gaucho-reference-images", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Upload failed.");
      setNewLabel("");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Upload failed."); }
    finally { setUploading(false); }
  };
  const removeReferenceImage = (id: string) => { if (window.confirm("Remove this reference photo?")) void request(`/api/finder/gaucho-reference-images?id=${encodeURIComponent(id)}`, { method: "DELETE" }); };

  const budgetPercent = data ? Math.min(100, Math.round((data.budget.analyses / data.budget.monthlyLimit) * 100)) : 0;
  const dailyPercent = data ? Math.min(100, Math.round((data.budget.dailyAnalyses / data.budget.dailyLimit) * 100)) : 0;

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder">← Back to deal finder</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Gaucho knife search settings</h1><p className="muted">Discovery leads with a live eBay image search against your reference photos below — no positive keyword is required to reach a candidate, since real gaucho knives are often mislabeled as things like &ldquo;letter opener&rdquo; or &ldquo;silver dagger.&rdquo; The negative-keyword list filters out obvious junk before anything reaches Gemini; the search-term list below is only a secondary net.</p></div></header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <section className="finder-layout">
      <div className="panel finder-keywords">
        <div className="panel-heading"><div><p className="eyebrow">REFERENCE PHOTOS</p><h2>{data.referenceImages.length} photo{data.referenceImages.length === 1 ? "" : "s"}</h2></div>
          <label className="upload">{uploading ? "Uploading…" : "+ Add"}<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadReferenceImage(file); event.target.value = ""; }} /></label>
        </div>
        <input aria-label="Label for the next uploaded reference photo" placeholder="Optional label for the next upload (e.g. maker/style name)" value={newLabel} onChange={(event) => setNewLabel(event.target.value)} style={{ marginTop: 12 }} />
        <div className="photo-grid" style={{ marginTop: 16 }}>
          {data.referenceImages.map((image) => <div className="photo" key={image.id}>
            {image.signedUrl ? <img src={image.signedUrl} alt={image.label || "Reference photo"} /> : <div className="finder-no-image">No preview</div>}
            <div className="photo-controls"><button type="button" aria-label={`Remove ${image.label || "reference photo"}`} onClick={() => removeReferenceImage(image.id)}>×</button></div>
            {image.label && <span>{image.label}</span>}
          </div>)}
          {data.referenceImages.length === 0 && <p className="muted">Upload at least one reference photo before running this finder — Gemini has nothing to compare candidates against otherwise.</p>}
        </div>
      </div>
      <div className="panel finder-keywords"><div className="panel-heading"><div><p className="eyebrow">SEARCH TERMS</p><h2>Keyword supplement</h2></div></div>
        <p className="muted">Secondary discovery only — the image search above is primary. Maker names and specific terms work well here.</p>
        <label className="keyword-toggle"><input type="checkbox" checked={data.settings.gauchoKeywordSearchEnabled} disabled={busy} onChange={(event) => void setKeywordSearchEnabled(event.target.checked)} /> Run keyword search</label>
        {!data.settings.gauchoKeywordSearchEnabled && <p className="muted">Keyword search is off — this run only discovers candidates via the image search above. The phrases below are kept, but none of them are searched until this is turned back on.</p>}
        <div className="keyword-list" style={data.settings.gauchoKeywordSearchEnabled ? undefined : { opacity: 0.5 }}>{data.keywords.map((keyword) => <div className="keyword-row" key={keyword.id}><span>{keyword.phrase}</span><label className="keyword-toggle"><input type="checkbox" checked={keyword.enabled} disabled={busy || !data.settings.gauchoKeywordSearchEnabled} onChange={(event) => void setKeywordEnabled(keyword, event.target.checked)} /> Active</label><button className="danger" aria-label={`Delete "${keyword.phrase}"`} disabled={busy} onClick={() => { if (window.confirm(`Delete "${keyword.phrase}"?`)) void request(`/api/finder/keywords?id=${encodeURIComponent(keyword.id)}`, { method: "DELETE" }); }}>Delete</button></div>)}</div>
        <form className="keyword-add" onSubmit={(event) => { event.preventDefault(); if (!newPhrase.trim()) return; void request("/api/finder/keywords", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phrase: newPhrase }) }).then(() => setNewPhrase("")); }}><input aria-label="Add another eBay search phrase" placeholder="Add another eBay search phrase" value={newPhrase} onChange={(event) => setNewPhrase(event.target.value)} /><button className="primary" disabled={busy}>Add</button></form>
      </div>
      <div className="panel finder-keywords"><div className="panel-heading"><div><p className="eyebrow">FILTER OUT</p><h2>Negative keywords</h2></div></div>
        <p className="muted">Applied to every candidate from both discovery paths before any photo is analyzed. Kept deliberately narrow — a term here can hide a genuine gaucho knife if it&rsquo;s too broad.</p>
        <div className="keyword-list">{data.negativeKeywords.map((keyword) => <div className="keyword-row" key={keyword.id}><span>{keyword.phrase}</span><label className="keyword-toggle"><input type="checkbox" checked={keyword.enabled} disabled={busy} onChange={(event) => void setNegativeEnabled(keyword, event.target.checked)} /> Active</label><button className="danger" aria-label={`Delete "${keyword.phrase}"`} disabled={busy} onClick={() => { if (window.confirm(`Delete "${keyword.phrase}"?`)) void request(`/api/finder/gaucho-negative-keywords?id=${encodeURIComponent(keyword.id)}`, { method: "DELETE" }); }}>Delete</button></div>)}</div>
        <form className="keyword-add" onSubmit={(event) => { event.preventDefault(); if (!newNegativePhrase.trim()) return; void request("/api/finder/gaucho-negative-keywords", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phrase: newNegativePhrase }) }).then(() => setNewNegativePhrase("")); }}><input aria-label="Add a negative keyword" placeholder="Add a negative keyword" value={newNegativePhrase} onChange={(event) => setNewNegativePhrase(event.target.value)} /><button className="primary" disabled={busy}>Add</button></form>
      </div>
      <aside className="panel finder-budget"><p className="eyebrow">MONTHLY GUARDRAIL ({data.budget.mode === "paid" ? "paid" : "free"} mode)</p><h2>{data.budget.analyses.toLocaleString()} analyses</h2><p className="muted">{data.budget.remaining.toLocaleString()} remain before the {data.budget.monthlyLimit.toLocaleString()}-analysis stop this month. This budget is shared with the pocket-knife and carving-set finders.</p><div className="budget-meter" role="progressbar" aria-valuenow={budgetPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly Gemini analysis budget used"><span style={{ width: `${budgetPercent}%` }} /></div><small>Conservative maximum used: {usd(data.budget.projectedMaximum)} / {usd(data.budget.monthlyLimit * 0.001)}</small>
        <div className="finder-daily-pacing"><p className="eyebrow">DAILY PACING</p><p className="muted">{data.budget.dailyAnalyses.toLocaleString()} / {data.budget.dailyLimit.toLocaleString()} analyses used today.</p><div className="budget-meter" role="progressbar" aria-valuenow={dailyPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Today's Gemini analysis pacing cap used"><span style={{ width: `${dailyPercent}%` }} /></div></div>
      </aside>
      <div className="panel finder-schedule">
        <div className="panel-heading"><div><p className="eyebrow">AUTOMATION</p><h2>Automatic scan schedule</h2></div></div>
        <label className="keyword-toggle"><input type="checkbox" checked={data.schedule.enabled} disabled={busy} onChange={(event) => void saveSchedule({ enabled: event.target.checked })} /> Run automatically</label>
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
        <p className="muted">Runs in America/New_York time. Scheduled independently from the other two finders.</p>
      </div>
      <div className="panel finder-notify">
        <div className="panel-heading"><div><p className="eyebrow">EMAIL ALERTS</p><h2>Notification settings</h2></div></div>
        <p className="muted">Shared with the other two finders — one recipient list and mode for all three, but gaucho-knife deals always go out in their own separate email.</p>
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
