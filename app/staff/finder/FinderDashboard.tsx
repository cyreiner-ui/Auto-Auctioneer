"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import FinderResultsGrid, { type FinderResult } from "./FinderResultsGrid";
import { usePersistedState } from "../../../lib/use-persisted-state";

type FinderKind = "pocket_knife" | "carving_set" | "gaucho_knife";

type Run = { id: string; trigger: string; status: string; keywords_scanned: number; current_keyword: string | null; items_seen: number; items_added: number; qualified: number; new_qualified: number; rejected: number; errors: string[]; started_at: string };
type Overview = { results: FinderResult[]; runs: Run[]; keywords: { id: string; phrase: string; enabled: boolean }[]; counts: { pending: number; rejected: number; qualified: number }; ebayCallsToday: number; settings: { zip: string; maxCostPerKnife: number } };

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const RUN_STATUS_LABEL: Record<string, string> = { running: "Working…", completed: "Done", failed: "Had a problem" };

const KIND_LABEL: Record<FinderKind, string> = { pocket_knife: "Pocket Knife Finder", carving_set: "Carving Set Finder", gaucho_knife: "Gaucho Knife Finder" };
const KIND_SETTINGS_HREF: Record<FinderKind, string> = { pocket_knife: "/staff/finder/settings", carving_set: "/staff/finder/carving-sets/settings", gaucho_knife: "/staff/finder/gaucho-knives/settings" };
const KIND_ARCHIVED_HREF: Record<FinderKind, string> = { pocket_knife: "/staff/finder/archived", carving_set: "/staff/finder/carving-sets/archived", gaucho_knife: "/staff/finder/gaucho-knives/archived" };
const KIND_REJECTED_HREF: Record<FinderKind, string> = { pocket_knife: "/staff/finder/rejected", carving_set: "/staff/finder/carving-sets/rejected", gaucho_knife: "/staff/finder/gaucho-knives/rejected" };

export default function FinderDashboard() {
  const [kind, setKind] = usePersistedState<FinderKind>("knife-auctions:finder-kind", "pocket_knife");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (forKind: FinderKind) => {
    const response = await fetch(`/api/finder?category=${forKind}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load finder.");
    setData(payload); setError("");
  }, []);

  // Switching finders shows its own loading state rather than the previous finder's stale data.
  // Both setState calls are deferred into the timer callback (not called synchronously in the
  // effect body) to avoid the cascading-render lint rule.
  useEffect(() => {
    const timer = window.setTimeout(() => { setData(null); void load(kind).catch((reason) => setError(reason.message)); }, 0);
    return () => window.clearTimeout(timer);
  }, [kind, load]);
  useEffect(() => {
    const runningNow = data?.runs.some((run) => run.status === "running");
    if (!data?.counts.pending && !runningNow) return;
    const timer = window.setInterval(() => void load(kind).catch(() => undefined), runningNow ? 2000 : 15000);
    return () => window.clearInterval(timer);
  }, [data, kind, load]);

  const request = async (url: string, init: RequestInit) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(url, init); const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed.");
      await load(kind); return payload;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(false); }
  };

  const archiveIds = (ebayItemIds: string[]) => request("/api/finder/items", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ebayItemIds, dismissed: true }) });
  const deleteIds = (ids: string[]) => request("/api/finder/items", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
  const setBidAndSend = async (result: FinderResult, maxBid: number) => {
    const payload = await request("/api/finder/items/gixen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ebayItemId: result.ebay_item_id, maxBid }) });
    if (payload) { setNotice(payload.ok ? "Bid saved and sent to Gixen." : `Gixen send failed: ${payload.message || ""}`); window.setTimeout(() => setNotice(""), 2600); }
  };
  const copyAndArchive = async (result: FinderResult) => {
    try { await navigator.clipboard?.writeText(result.ebay_url); } catch { /* clipboard access is best-effort */ }
    const ok = await archiveIds([result.ebay_item_id]);
    if (ok) { setNotice("Link copied and archived."); window.setTimeout(() => setNotice(""), 1800); }
  };
  const viewAndArchive = (result: FinderResult) => {
    window.open(result.ebay_url, "_blank", "noopener,noreferrer");
    void archiveIds([result.ebay_item_id]).then((ok) => { if (ok) { setNotice("Opened on eBay and archived."); window.setTimeout(() => setNotice(""), 1800); } });
  };
  const latest = data?.runs[0];
  const totalKeywords = data?.keywords.filter((keyword) => keyword.enabled).length || latest?.keywords_scanned || 0;
  const progressPercent = latest?.status === "running" && totalKeywords ? Math.min(100, Math.round((latest.keywords_scanned / totalKeywords) * 100)) : 0;

  const friendlyError = (message: string) => {
    if (message.includes("finder_") || message.includes("relation")) return "Apply the finder database migration, then reload this page.";
    const looksTechnical = /column|does not exist|violates|constraint|syntax error/i.test(message) || message.length > 160;
    return looksTechnical ? "Something went wrong. Please try again in a moment." : message;
  };

  return <main className="finder-page">
    <header className="finder-header">
      <div>
        <Link className="back" href="/">← Back to staff panel</Link>
        <p className="eyebrow">EBAY DISCOVERY</p>
        <div className="finder-kind-switch">
          <label className="visually-hidden" htmlFor="finder-kind-select">Choose finder</label>
          <select id="finder-kind-select" value={kind} onChange={(event) => setKind(event.target.value as FinderKind)}>
            <option value="pocket_knife">{KIND_LABEL.pocket_knife}</option>
            <option value="carving_set">{KIND_LABEL.carving_set}</option>
            <option value="gaucho_knife">{KIND_LABEL.gaucho_knife}</option>
          </select>
        </div>
        <h1>{KIND_LABEL[kind]}</h1>
        <p className="muted">
          {kind === "pocket_knife"
            ? <>Daily snapshots delivered to {data?.settings.zip ?? "—"} · maximum {usd(data?.settings.maxCostPerKnife ?? 0)} per knife including shipping</>
            : kind === "carving_set"
            ? <>Sheffield/English sets: $200 flat, carbon steel only. German and other cased sets: $10 × piece count + $15. A case is required for all three.</>
            : <>Discovered by visual match against your reference photos (plus a keyword-search supplement) — no price cap yet, review every match yourself.</>}
        </p>
        <div className="finder-header-links">
          <Link className="back finder-settings-link" href={KIND_SETTINGS_HREF[kind]}>Search settings</Link>
          <Link className="back finder-settings-link" href={KIND_ARCHIVED_HREF[kind]}>Archived items</Link>
          <Link className="back finder-settings-link" href={KIND_REJECTED_HREF[kind]}>Rejected items</Link>
          <Link className="back finder-settings-link" href="/staff/finder/debug">Debugger</Link>
        </div>
      </div>
      <button className="primary" disabled={busy} onClick={() => void request("/api/finder/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: kind }) })}>{busy ? "Working…" : "Run now"}</button>
    </header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{friendlyError(error)}</div>}
    {notice && <div className="notice" role="status" aria-live="polite" aria-atomic="true">{notice}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <>
      <section className="finder-stats">
        <div><small>GOOD DEALS FOUND</small><strong>{data.counts.qualified}</strong></div><div><small>STILL CHECKING</small><strong>{data.counts.pending}</strong></div><div><small>NOT A MATCH</small><strong>{data.counts.rejected}</strong></div><div><small>EBAY API CALLS TODAY</small><strong>{data.ebayCallsToday}</strong></div>
      </section>
      <section className="finder-runs"><div className="section-title"><div><p className="eyebrow">LATEST SEARCH</p><h2>{latest ? new Date(latest.started_at).toLocaleString() : "Not run yet"}</h2></div>{latest && <span className={`run-status ${latest.status}`}>{RUN_STATUS_LABEL[latest.status] || latest.status}</span>}</div>
        {latest?.status === "running" && <div className="finder-progress"><div className="budget-meter" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Search progress"><span style={{ width: `${progressPercent}%` }} /></div><p className="muted">Searching {latest.keywords_scanned}/{totalKeywords || "…"}{latest.current_keyword ? `: “${latest.current_keyword}”` : ""}</p></div>}
        {latest && latest.status !== "running" && <p className="muted">Found {latest.new_qualified} good deal{latest.new_qualified === 1 ? "" : "s"} among {latest.items_added} new listing{latest.items_added === 1 ? "" : "s"} today.</p>}{latest?.errors?.map((message) => <p className="finder-run-error" key={message}>{message}</p>)}</section>
      <section className="finder-results"><div className="section-title"><div><p className="eyebrow">QUALIFYING SNAPSHOTS</p><h2>{kind === "pocket_knife" ? "Deals at or below $3.50 per knife" : "Cased carving sets within budget"}</h2></div></div>
        <FinderResultsGrid
          results={data.results}
          variant={kind}
          busy={busy}
          emptyMessage="No qualifying snapshots yet. Run the finder or wait for the daily 6:00 AM search."
          actions={[
            { label: "View & Archive", className: "primary", onClick: (result) => viewAndArchive(result) },
            { label: "Copy & Archive", onClick: (result) => void copyAndArchive(result) },
          ]}
          bulkActions={[
            { label: "Archive", onClick: (ids) => void archiveIds(ids) },
            { label: "Delete", className: "danger", onClick: (ids) => { if (window.confirm(`Delete ${ids.length} item${ids.length === 1 ? "" : "s"}?`)) void deleteIds(ids); } },
          ]}
          bidAction={{ onSubmit: setBidAndSend }}
        />
      </section>
    </>}
  </main>;
}
