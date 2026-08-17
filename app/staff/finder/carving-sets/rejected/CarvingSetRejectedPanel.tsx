"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import FinderResultsGrid, { type FinderResult } from "../../FinderResultsGrid";

type Overview = { results: FinderResult[] };

export default function CarvingSetRejectedPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/finder/rejected?category=carving_set", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load rejected items.");
    setData(payload); setError("");
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load().catch((reason) => setError(reason.message)), 0); return () => window.clearTimeout(timer); }, [load]);

  const deleteIds = async (ids: string[]) => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/finder/items", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(false); }
  };

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder">← Back to finder</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Rejected carving sets</h1><p className="muted">Listings the finder looked at but didn&rsquo;t qualify, with why. Useful for checking a set you found manually against what the finder decided.</p></div></header>
    {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
    {!data && !error && <p className="muted" role="status" aria-live="polite">Loading…</p>}
    {data && <section className="finder-results">
      <FinderResultsGrid
        results={data.results}
        variant="carving_set"
        busy={busy}
        emptyMessage="Nothing rejected yet."
        actions={[
          { label: "View", className: "primary", onClick: (result) => window.open(result.ebay_url, "_blank", "noopener,noreferrer") },
          { label: "Delete", className: "danger", onClick: (result) => { if (window.confirm(`Delete "${result.title}"?`)) void deleteIds([result.ebay_item_id]); } },
        ]}
        bulkActions={[
          { label: "Delete", className: "danger", onClick: (ids) => { if (window.confirm(`Delete ${ids.length} item${ids.length === 1 ? "" : "s"}?`)) void deleteIds(ids); } },
        ]}
      />
    </section>}
  </main>;
}
