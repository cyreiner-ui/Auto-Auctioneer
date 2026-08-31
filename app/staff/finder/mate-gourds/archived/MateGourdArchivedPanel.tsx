"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import FinderResultsGrid, { type FinderResult } from "../../FinderResultsGrid";

type Overview = { results: FinderResult[] };

export default function MateGourdArchivedPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/finder/archived?category=mate_gourd", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load archived items.");
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

  const restoreIds = (ebayItemIds: string[]) => request("/api/finder/items", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ebayItemIds, dismissed: false }) });
  const deleteIds = (ids: string[]) => request("/api/finder/items", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder">← Back to finder</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Archived maté gourds</h1><p className="muted">Deals you&rsquo;ve already handled. Restore one to see it again, or delete it for good.</p></div></header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <section className="finder-results">
      <FinderResultsGrid
        results={data.results}
        variant="mate_gourd"
        busy={busy}
        emptyMessage="No archived items yet."
        actions={[
          { label: "View", className: "primary", onClick: (result) => window.open(result.ebay_url, "_blank", "noopener,noreferrer") },
          { label: "Restore", onClick: (result) => void restoreIds([result.ebay_item_id]) },
          { label: "Delete", className: "danger", onClick: (result) => { if (window.confirm(`Delete "${result.title}"?`)) void deleteIds([result.ebay_item_id]); } },
        ]}
        bulkActions={[
          { label: "Restore", onClick: (ids) => void restoreIds(ids) },
          { label: "Delete", className: "danger", onClick: (ids) => { if (window.confirm(`Delete ${ids.length} item${ids.length === 1 ? "" : "s"}?`)) void deleteIds(ids); } },
        ]}
      />
    </section>}
  </main>;
}
