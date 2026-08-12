"use client";

import { useState } from "react";

export type FinderResult = { ebay_item_id: string; title: string; ebay_url: string; image_url: string | null; item_price: number; shipping_cost: number; total_cost: number; cost_per_knife: number; knife_count: number; detection_source: string; discovered_at: string; gixen_status?: string | null; gixen_message?: string | null; buying_options: string[]; max_bid: number | null };

type ResultAction = { label: string; className?: string; visible?: (result: FinderResult) => boolean; onClick: (result: FinderResult) => void };
type BulkAction = { label: string; className?: string; onClick: (ids: string[]) => void };
type BidSubmit = { onSubmit: (result: FinderResult, maxBid: number) => Promise<void> | void };

const GIXEN_BADGE: Record<string, string> = { sent: "Sent to Gixen", failed: "Gixen send failed", not_auction: "Not an auction" };

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

// Mirrors isAuctionFormat in lib/gixen-client.ts — keep in sync. Duplicated
// here (rather than imported) since gixen-client.ts pulls in a server-only
// Playwright/Chromium driver that shouldn't reach the client bundle.
const isAuctionFormat = (buyingOptions: string[]) => Array.isArray(buyingOptions) && buyingOptions.includes("AUCTION");

export default function FinderResultsGrid({ results, busy, emptyMessage, actions, bulkActions, bidAction }: { results: FinderResult[]; busy: boolean; emptyMessage: string; actions: ResultAction[]; bulkActions: BulkAction[]; bidAction?: BidSubmit }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bidDrafts, setBidDrafts] = useState<Record<string, string>>({});

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
          <div className="finder-badges"><span>{result.knife_count} knives</span>{result.gixen_status && <span className={result.gixen_status === "failed" ? "gixen-failed" : undefined} title={result.gixen_message || undefined}>{GIXEN_BADGE[result.gixen_status] || result.gixen_status}</span>}</div>
          <h3>{result.title}</h3>
          <p className="finder-price-line">{usd(result.item_price)} + {usd(result.shipping_cost)} shipping = {usd(result.total_cost)} total</p>
          <strong className="finder-unit-price">{usd(result.cost_per_knife)} / knife</strong>
          <p className="finder-snapshot">Price captured {new Date(result.discovered_at).toLocaleString()}. Verify the current price on eBay.</p>
          {bidAction && isAuctionFormat(result.buying_options) && result.gixen_status !== "sent" && result.gixen_status !== "not_auction" &&
            <div className="finder-bid-row">
              <input type="number" min="0.01" step="0.01" inputMode="decimal"
                aria-label={`Max bid for ${result.title}`}
                value={bidDrafts[result.ebay_item_id] ?? String(result.max_bid ?? result.total_cost ?? "")}
                onChange={(event) => setBidDrafts((current) => ({ ...current, [result.ebay_item_id]: event.target.value }))} />
              <button disabled={busy} onClick={() => void bidAction.onSubmit(result, Number(bidDrafts[result.ebay_item_id] ?? result.max_bid ?? result.total_cost))}>
                {result.gixen_status === "failed" ? "Retry with this bid" : "Set & Send"}
              </button>
            </div>}
          <div className="finder-card-actions">{actions.filter((action) => !action.visible || action.visible(result)).map((action) => <button key={action.label} className={action.className} disabled={busy} aria-label={`${action.label} ${result.title}`} onClick={() => action.onClick(result)}>{action.label}</button>)}</div>
        </div>
      </article>)}
      {results.length === 0 && <div className="empty">{emptyMessage}</div>}
    </div>
  </div>;
}
