"use client";

import { useMemo, useState } from "react";
import { usePersistedState } from "../../../lib/use-persisted-state";

export type FinderResult = {
  ebay_item_id: string; title: string; ebay_url: string; image_url: string | null; item_price: number; shipping_cost: number; total_cost: number; cost_per_knife: number; knife_count: number; detection_source: string; discovered_at: string; gixen_status?: string | null; gixen_message?: string | null; buying_options: string[]; max_bid: number | null;
  carving_piece_count?: number | null; carving_has_case?: boolean | null; carving_carbon_steel?: boolean | null; carving_handle_material?: "stag" | "ivory" | "other" | null;
  gaucho_match_confidence?: number | null; gaucho_maker_match?: boolean | null; gaucho_match_notes?: string | null;
  reason?: string | null;
};
export type FinderResultsVariant = "pocket_knife" | "carving_set" | "gaucho_knife";

type ResultAction = { label: string; className?: string; visible?: (result: FinderResult) => boolean; onClick: (result: FinderResult) => void };
type BulkAction = { label: string; className?: string; onClick: (ids: string[]) => void };
type BidSubmit = { onSubmit: (result: FinderResult, maxBid: number) => Promise<void> | void };
type SortKey = "discovered_desc" | "price_asc" | "price_desc" | "cpk_asc" | "cpk_desc";
type TypeFilter = "AUCTION" | "BEST_OFFER" | "FIXED_PRICE";

const GIXEN_BADGE: Record<string, string> = { sent: "Sent to Gixen", failed: "Gixen send failed", not_auction: "Not an auction" };
const TYPE_FILTER_LABEL: Record<TypeFilter, string> = { AUCTION: "Bidding", BEST_OFFER: "Best offer", FIXED_PRICE: "Set price" };

// Known `finder_items.reason` codes (see lib/finder-core.ts's analyzeListingText/calculateDeal,
// lib/finder-service.ts's initialRow/refreshedRow/processPendingFinderItems, and
// lib/carving-set-finder.ts's initialCarvingSetRow) mapped to a staff-readable explanation. Anything
// not in this map (a dynamic Gemini/eBay error message, or a not-yet-catalogued code) falls back to
// showing the raw reason string rather than being silently hidden.
const REJECTION_REASON_LABEL: Record<string, string> = {
  selection_listing: "Buyer picks one item from a lot — quantity isn't fixed",
  no_knives_included: "Listing says no knives are actually included",
  box_cutter: "Box cutter, not a pocket knife",
  credit_card_knife: "Credit-card/wallet novelty knife",
  coin_knife: "Coin novelty knife",
  plain_blade: "Replacement/bare blade, not a full knife",
  throwing_knife: "Throwing knife",
  keychain_knife: "Keychain novelty knife",
  weight_based_lot: "Sold by weight — quantity isn't stated",
  multi_tool: "Multi-tool (corkscrew/pliers/bottle-opener), not a pocket knife",
  non_folding_cutlery: "Reads as kitchen/table cutlery, not a folding knife",
  table_cutlery: "Photo confirmed a flatware/silverware set, not a folding knife",
  no_folding_knife: "Photo didn't show a folding pocket knife",
  invalid_price: "Listing had no usable price",
  missing_shipping: "Shipping cost couldn't be determined",
  invalid_count: "Knife count couldn't be determined",
  implausible_count: "Counted more knives than plausible for one listing",
  over_budget: "Over the per-knife budget",
  non_usd_currency: "Priced in a non-USD currency",
  non_usd_shipping: "Shipping quoted in a non-USD currency",
  ended: "Listing had already ended",
  missing_image: "No photo to analyze",
  low_confidence: "Photo analysis wasn't confident enough",
  no_case: "No case/box shown or mentioned",
  not_carving_set: "Listing text never actually says \"carving set\"",
  stainless_steel: "Stated or implied stainless steel, not carbon steel",
  stainless_steel_vision: "Photo confirmed stainless steel, not carbon steel",
  stainless_era_wording: "Wording suggests a later stainless-era set, not carbon steel",
  faux_handle: "Imitation (faux) handle material, typical of later stainless sets",
  modern_origin: "Modern (USA/Japan-made) manufacture, not antique English/German",
  wood_carving_tool: "Wood-carving/whittling tool kit, not table-carving cutlery",
  not_stag_handle: "Handle material isn't stag/antler (or, for Sheffield, ivory)",
  not_stag_handle_vision: "Photo didn't confirm a stag/antler (or, for Sheffield, ivory) handle",
  negative_keyword_match: "Matched a negative keyword before any photo analysis",
};

function rejectionLabel(reason: string) { return REJECTION_REASON_LABEL[reason] || reason; }

const usd = (value: number) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

// Mirrors isAuctionFormat in lib/gixen-client.ts — keep in sync. Duplicated
// here (rather than imported) since gixen-client.ts pulls in a server-only
// Playwright/Chromium driver that shouldn't reach the client bundle.
const isAuctionFormat = (buyingOptions: string[]) => Array.isArray(buyingOptions) && buyingOptions.includes("AUCTION");
const hasBuyingOption = (buyingOptions: string[], type: TypeFilter) => Array.isArray(buyingOptions) && buyingOptions.includes(type);

export default function FinderResultsGrid({ results, busy, emptyMessage, actions, bulkActions, bidAction, variant = "pocket_knife" }: { results: FinderResult[]; busy: boolean; emptyMessage: string; actions: ResultAction[]; bulkActions: BulkAction[]; bidAction?: BidSubmit; variant?: FinderResultsVariant }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bidDrafts, setBidDrafts] = useState<Record<string, string>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [sortKey, setSortKey] = usePersistedState<SortKey>("knife-auctions:finder-sort", "discovered_desc");
  const [typeFilter, setTypeFilter] = usePersistedState<TypeFilter[]>("knife-auctions:finder-type-filter", []);

  const toggleTypeFilter = (type: TypeFilter) => setTypeFilter((current) => current.includes(type) ? current.filter((t) => t !== type) : [...current, type]);
  const resetFilters = () => { setTypeFilter([]); setSortKey("discovered_desc"); };

  const visibleResults = useMemo(() => {
    const filtered = typeFilter.length === 0 ? results : results.filter((result) => typeFilter.some((type) => hasBuyingOption(result.buying_options, type)));
    const sorted = [...filtered];
    if (sortKey === "price_asc") sorted.sort((a, b) => a.total_cost - b.total_cost);
    else if (sortKey === "price_desc") sorted.sort((a, b) => b.total_cost - a.total_cost);
    else if (sortKey === "cpk_asc") sorted.sort((a, b) => a.cost_per_knife - b.cost_per_knife);
    else if (sortKey === "cpk_desc") sorted.sort((a, b) => b.cost_per_knife - a.cost_per_knife);
    return sorted;
  }, [results, sortKey, typeFilter]);

  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allSelected = visibleResults.length > 0 && visibleResults.every((result) => selected.has(result.ebay_item_id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visibleResults.map((result) => result.ebay_item_id)));
  const runBulk = (action: BulkAction) => { action.onClick([...selected]); setSelected(new Set()); };
  const filtersActive = panelOpen || typeFilter.length > 0 || sortKey !== "discovered_desc";

  return <div className="finder-grid-wrap">
    {results.length > 0 && <div className="finder-bulk-bar">
      <label className="finder-select-all"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all results" /> {selected.size > 0 ? `${selected.size} selected` : "Select all"}</label>
      <div className="finder-bulk-right">
        {selected.size > 0 && <div className="finder-bulk-actions">{bulkActions.map((action) => <button key={action.label} className={action.className} disabled={busy} onClick={() => runBulk(action)}>{action.label} ({selected.size})</button>)}</div>}
        <div className="finder-filter-wrap">
          <button type="button" className={`finder-filter-toggle${filtersActive ? " active" : ""}`} aria-label="Filter and sort results" aria-expanded={panelOpen} onClick={() => setPanelOpen((open) => !open)}>⚙</button>
          {panelOpen && <div className="finder-filter-panel">
            <div className="finder-filter-group">
              <span>Sort</span>
              <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} aria-label="Sort results">
                <option value="discovered_desc">Newest first</option>
                <option value="price_asc">Price: low to high</option>
                <option value="price_desc">Price: high to low</option>
                {variant === "pocket_knife" && <option value="cpk_asc">Cost per knife: low to high</option>}
                {variant === "pocket_knife" && <option value="cpk_desc">Cost per knife: high to low</option>}
              </select>
            </div>
            <div className="finder-filter-group">
              <span>Type</span>
              {(Object.keys(TYPE_FILTER_LABEL) as TypeFilter[]).map((type) => <label key={type}><input type="checkbox" checked={typeFilter.includes(type)} onChange={() => toggleTypeFilter(type)} /> {TYPE_FILTER_LABEL[type]}</label>)}
            </div>
            <button type="button" className="finder-filter-reset" onClick={resetFilters}>Reset</button>
          </div>}
        </div>
      </div>
    </div>}
    <div className="finder-grid">
      {visibleResults.map((result) => <article className="finder-card" key={result.ebay_item_id}>
        <label className="finder-card-select"><input type="checkbox" checked={selected.has(result.ebay_item_id)} onChange={() => toggle(result.ebay_item_id)} aria-label={`Select ${result.title}`} /></label>
        {result.image_url ? <img src={result.image_url} alt={result.title} /> : <div className="finder-no-image">No image</div>}
        <div className="finder-card-body">
          <div className="finder-badges">
            {variant === "carving_set"
              ? <>
                  <span>{result.carving_piece_count ?? 1} piece{(result.carving_piece_count ?? 1) === 1 ? "" : "s"}</span>
                  {result.carving_has_case && <span>Cased</span>}
                  {result.carving_carbon_steel && <span>Carbon steel</span>}
                  {result.carving_handle_material === "stag" && <span>Stag handle</span>}
                  {result.carving_handle_material === "ivory" && <span>Ivory handle</span>}
                </>
              : variant === "gaucho_knife"
              ? <>
                  {result.gaucho_match_confidence != null && <span>{Math.round(result.gaucho_match_confidence * 100)}% match</span>}
                  {result.gaucho_maker_match === true && <span>Maker matches</span>}
                  {result.gaucho_maker_match === false && <span>Maker doesn&apos;t match</span>}
                </>
              : <span>{result.knife_count != null ? `${result.knife_count} knives` : "Knife count unknown"}</span>}
            {result.gixen_status && <span className={result.gixen_status === "failed" ? "gixen-failed" : undefined} title={result.gixen_message || undefined}>{GIXEN_BADGE[result.gixen_status] || result.gixen_status}</span>}
          </div>
          <h3>{result.title}</h3>
          <p className="finder-price-line">{usd(result.item_price)}{result.shipping_cost != null ? ` + ${usd(result.shipping_cost)} shipping` : ""}{result.total_cost != null ? ` = ${usd(result.total_cost)} total` : ""}</p>
          {variant === "pocket_knife" && result.cost_per_knife != null && <strong className="finder-unit-price">{usd(result.cost_per_knife)} / knife</strong>}
          {variant === "gaucho_knife" && result.gaucho_match_notes && <p className="finder-snapshot">{result.gaucho_match_notes}</p>}
          {result.reason && <p className="finder-reject-reason">Not a match: {rejectionLabel(result.reason)}</p>}
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
      {results.length > 0 && visibleResults.length === 0 && <div className="empty">No results match the current filters.</div>}
    </div>
  </div>;
}
