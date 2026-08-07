"use client";

import { useState } from "react";

export type FinderResult = { ebay_item_id: string; title: string; ebay_url: string; image_url: string | null; item_price: number; shipping_cost: number; total_cost: number; cost_per_knife: number; knife_count: number; buying_options: string[]; detection_source: string; discovered_at: string };

type ResultAction = { label: string; className?: string; onClick: (result: FinderResult) => void };
type BulkAction = { label: string; className?: string; onClick: (ids: string[]) => void };

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function FinderResultsGrid({ results, busy, emptyMessage, actions, bulkActions }: { results: FinderResult[]; busy: boolean; emptyMessage: string; actions: ResultAction[]; bulkActions: BulkAction[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allSelected = results.length > 0 && results.every((result) => selected.has(result.ebay_item_id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(results.map((result) => result.ebay_item_id)));
  const runBulk = (action: BulkAction) => { action.onClick([...selected]); setSelected(new Set()); };

  return <div className="finder-grid-wrap">
    {results.length > 0 && <div className="finder-bulk-bar">
      <label className="finder-select-all"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all results" /> {selected.size > 0 ? `${selected.size} selected` : "Select all"}</label>
      {selected.size > 0 && <div className="finder-bulk-actions">{bulkActions.map((action) => <button key={action.label} className={action.className} disabled={busy} onClick={() => runBulk(action)}>{action.label} ({selected.size})</button>)}</div>}
    </div>}
    <div className="finder-grid">
      {results.map((result) => <article className="finder-card" key={result.ebay_item_id}>
        <label className="finder-card-select"><input type="checkbox" checked={selected.has(result.ebay_item_id)} onChange={() => toggle(result.ebay_item_id)} aria-label={`Select ${result.title}`} /></label>
        {result.image_url ? <img src={result.image_url} alt={result.title} /> : <div className="finder-no-image">No image</div>}
        <div className="finder-card-body">
          <div className="finder-badges"><span>{result.buying_options.includes("AUCTION") ? "Auction" : "Buy It Now"}</span><span>{result.knife_count} knives</span></div>
          <h3>{result.title}</h3>
          <p className="finder-price-line">{usd(result.item_price)} + {usd(result.shipping_cost)} shipping = {usd(result.total_cost)} total</p>
          <strong className="finder-unit-price">{usd(result.cost_per_knife)} / knife</strong>
          <p className="finder-snapshot">Price captured {new Date(result.discovered_at).toLocaleString()}. Verify the current price on eBay.</p>
          <div className="finder-card-actions">{actions.map((action) => <button key={action.label} className={action.className} disabled={busy} aria-label={`${action.label} ${result.title}`} onClick={() => action.onClick(result)}>{action.label}</button>)}</div>
        </div>
      </article>)}
      {results.length === 0 && <div className="empty">{emptyMessage}</div>}
    </div>
  </div>;
}
