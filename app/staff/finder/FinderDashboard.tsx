"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import FinderResultsGrid, { type FinderResult } from "./FinderResultsGrid";

type Run = { id: string; trigger: string; status: string; keywords_scanned: number; items_seen: number; items_added: number; qualified: number; rejected: number; errors: string[]; started_at: string };
type Overview = { results: FinderResult[]; runs: Run[]; counts: { pending: number; rejected: number; qualified: number }; settings: { zip: string; maxCostPerKnife: number } };

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const RUN_STATUS_LABEL: Record<string, string> = { running: "Working…", completed: "Done", failed: "Had a problem" };

export default function FinderDashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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

  const archiveIds = (ebayItemIds: string[]) => request("/api/finder/items", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ebayItemIds, dismissed: true }) });
  const deleteIds = (ids: string[]) => request("/api/finder/items", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
  const retryGixen = async (result: FinderResult) => {
    const payload = await request("/api/finder/items/gixen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ebayItemId: result.ebay_item_id }) });
    if (payload) { setNotice(payload.ok ? "Sent to Gixen." : `Gixen send failed: ${payload.message || ""}`); window.setTimeout(() => setNotice(""), 2600); }
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

  const friendlyError = (message: string) => {
    if (message.includes("finder_") || message.includes("relation")) return "Apply the finder database migration, then reload this page.";
    const looksTechnical = /column|does not exist|violates|constraint|syntax error/i.test(message) || message.length > 160;
    return looksTechnical ? "Something went wrong. Please try again in a moment." : message;
  };

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/">← Back to staff panel</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Pocket-knife deal finder</h1><p className="muted">Daily snapshots delivered to {data?.settings.zip ?? "—"} · maximum {usd(data?.settings.maxCostPerKnife ?? 0)} per knife including shipping</p><div className="finder-header-links"><Link className="back finder-settings-link" href="/staff/finder/settings">Search settings</Link><Link className="back finder-settings-link" href="/staff/finder/archived">Archived items</Link></div></div><button className="primary" disabled={busy} onClick={() => void request("/api/finder/run", { method: "POST" })}>{busy ? "Working…" : "Run now"}</button></header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{friendlyError(error)}</div>}
    {notice && <div className="notice" role="status" aria-live="polite" aria-atomic="true">{notice}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <>
      <section className="finder-stats">
        <div><small>GOOD DEALS FOUND</small><strong>{data.counts.qualified}</strong></div><div><small>STILL CHECKING</small><strong>{data.counts.pending}</strong></div><div><small>NOT A MATCH</small><strong>{data.counts.rejected}</strong></div>
      </section>
      <section className="finder-runs"><div className="section-title"><div><p className="eyebrow">LATEST SEARCH</p><h2>{latest ? new Date(latest.started_at).toLocaleString() : "Not run yet"}</h2></div>{latest && <span className={`run-status ${latest.status}`}>{RUN_STATUS_LABEL[latest.status] || latest.status}</span>}</div>{latest && <p className="muted">Found {latest.qualified} good deal{latest.qualified === 1 ? "" : "s"} from {latest.items_added} new listing{latest.items_added === 1 ? "" : "s"}.</p>}{latest?.errors?.map((message) => <p className="finder-run-error" key={message}>{message}</p>)}</section>
      <section className="finder-results"><div className="section-title"><div><p className="eyebrow">QUALIFYING SNAPSHOTS</p><h2>Deals at or below $3.50 per knife</h2></div></div>
        <FinderResultsGrid
          results={data.results}
          busy={busy}
          emptyMessage="No qualifying snapshots yet. Run the finder or wait for the daily 6:00 AM search."
          actions={[
            { label: "View & Archive", className: "primary", onClick: (result) => viewAndArchive(result) },
            { label: "Copy & Archive", onClick: (result) => void copyAndArchive(result) },
            { label: "Retry Gixen", visible: (result) => result.gixen_status === "failed", onClick: (result) => void retryGixen(result) },
          ]}
          bulkActions={[
            { label: "Archive", onClick: (ids) => void archiveIds(ids) },
            { label: "Delete", className: "danger", onClick: (ids) => { if (window.confirm(`Delete ${ids.length} item${ids.length === 1 ? "" : "s"}?`)) void deleteIds(ids); } },
          ]}
        />
      </section>
    </>}
  </main>;
}
