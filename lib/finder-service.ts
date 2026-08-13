import { randomUUID } from "node:crypto";
import { appToken, getItemShippingCost, searchEbayKeyword, type EbayFinderItem } from "./ebay-finder";
import { analyzeListingText, calculateDeal, FINDER_DEFAULTS, isDailyFinderHour, isShippingLookupWorthwhile, monthKey, resolveMaxCostPerKnife } from "./finder-core";
import { countKnivesWithGemini, VisionBudgetError, VisionQuotaError } from "./gemini-vision";
import { isAuctionFormat } from "./gixen-client";
import { sendQualifiedItemsEmail } from "./finder-notify";
import { supabaseAdmin } from "./supabase-admin";

async function notifyNewlyQualified(ebayItemIds: string[]) {
  if (!ebayItemIds.length) return;
  const { data, error } = await supabaseAdmin
    .from("finder_items")
    .select("ebay_item_id, title, ebay_url, image_url, item_price, shipping_cost, total_cost, cost_per_knife, knife_count, notified_at, gixen_status, buying_options")
    .eq("status", "qualified")
    .in("ebay_item_id", ebayItemIds);
  if (error || !data?.length) return;
  const unnotified = data.filter((row) => !row.notified_at && isAuctionFormat(row.buying_options));
  if (unnotified.length) {
    const emailResult = await sendQualifiedItemsEmail(unnotified);
    if (emailResult.ok) {
      await supabaseAdmin.from("finder_items").update({ notified_at: new Date().toISOString() }).in("ebay_item_id", unnotified.map((row) => row.ebay_item_id));
    }
  }
  const notAuction = data.filter((row) => !row.gixen_status && !isAuctionFormat(row.buying_options));
  if (notAuction.length) {
    await supabaseAdmin.from("finder_items").update({
      gixen_status: "not_auction",
      gixen_message: "Gixen only snipes eBay auctions; this is a fixed-price listing.",
      gixen_sent_at: null,
    }).in("ebay_item_id", notAuction.map((row) => row.ebay_item_id));
  }
  // Auction-format items are intentionally left alone here — gixen_status
  // stays whatever it already was (null on first qualification). Sending to
  // Gixen now only happens when a human enters a real max bid via
  // POST /api/finder/items/gixen (the inline bid control in FinderResultsGrid).
}

type FinderRow = {
  ebay_item_id: string;
  run_id: string | null;
  keyword_phrases: string[] | null;
  title: string;
  short_description: string;
  image_url: string | null;
  item_price: number | string;
  shipping_cost: number | string | null;
  shipping_source: string | null;
  knife_count: number | null;
  status: string;
  attempts: number;
};

const config = () => ({
  maxCost: Number(process.env.EBAY_FINDER_MAX_PER_KNIFE || FINDER_DEFAULTS.maxCostPerKnife),
  confidence: Number(process.env.GEMINI_CONFIDENCE_THRESHOLD || FINDER_DEFAULTS.confidence),
  searchDepth: Number(process.env.EBAY_FINDER_RESULTS_PER_KEYWORD || FINDER_DEFAULTS.resultsPerKeyword),
  batchSize: Number(process.env.GEMINI_BATCH_SIZE || FINDER_DEFAULTS.batchSize),
  processConcurrency: Number(process.env.FINDER_PROCESS_CONCURRENCY || FINDER_DEFAULTS.processConcurrency),
  scanConcurrency: Number(process.env.EBAY_FINDER_SCAN_CONCURRENCY || FINDER_DEFAULTS.scanConcurrency),
  monthlyLimit: Number(process.env.GEMINI_MONTHLY_ANALYSIS_LIMIT || FINDER_DEFAULTS.monthlyPaidAnalysisLimit),
});

// Runs `worker` over `items` with at most `concurrency` in flight at once, preserving each
// result at its original index. Plain Promise.all(items.map(...)) would fire every item at
// once — fine for a handful of keywords, but with thousands of pending items or dozens of
// keywords that saturates outbound connections and blows through third-party rate limits.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function runNext(): Promise<void> {
    const index = cursor++;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runNext));
  return results;
}

// How long a "running" finder_runs row is trusted to genuinely still be in progress before a
// new startFinderRun call is willing to start its own scan alongside it. This exists to stop
// two overlapping scans (e.g. a double click on "Run now", or a manual run landing on top of
// the daily scheduled one) from duplicating eBay calls and interleaving writes to the same
// pending queue. It intentionally does NOT try to detect or repair a run that got orphaned by a
// crash/timeout — a run stuck in "running" for longer than this window is simply no longer
// treated as active, and a fresh run is allowed to start. With the scan and batch phases now
// running concurrently (see mapWithConcurrency above), a genuine run finishes in well under a
// minute, so this window has generous headroom without risking a long-dead row blocking things
// indefinitely.
const RUN_LOCK_WINDOW_MS = 15 * 60 * 1000;

async function findActiveRun() {
  const { data, error } = await supabaseAdmin.from("finder_runs").select("*").eq("status", "running").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const startedAt = new Date(data.started_at).getTime();
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > RUN_LOCK_WINDOW_MS) return null;
  return data;
}

function easternDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function initialRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, maxCost: number) {
  const base = {
    ebay_item_id: item.itemId,
    run_id: runId,
    keyword_phrases: keywordPhrases,
    title: item.title,
    short_description: item.shortDescription,
    ebay_url: item.itemWebUrl,
    image_url: item.imageUrl,
    item_price: Number.isFinite(item.itemPrice) ? item.itemPrice : 0,
    shipping_cost: item.shippingCost,
    currency: item.currency,
    buying_options: item.buyingOptions,
    item_end_date: item.itemEndDate,
  };
  if (item.currency !== "USD") return { ...base, status: "rejected", reason: "non_usd_currency", processed_at: new Date().toISOString() };
  if (item.shippingCost != null && item.shippingCurrency !== "USD") return { ...base, status: "rejected", reason: "non_usd_shipping", processed_at: new Date().toISOString() };
  if (!Number.isFinite(item.itemPrice) || item.itemPrice < 0) return { ...base, status: "rejected", reason: "invalid_price", processed_at: new Date().toISOString() };
  if (item.itemEndDate && new Date(item.itemEndDate).getTime() <= Date.now()) return { ...base, status: "rejected", reason: "ended", processed_at: new Date().toISOString() };
  const text = analyzeListingText(item.title, item.shortDescription);
  if (text.kind === "reject") return { ...base, status: "rejected", reason: text.reason, processed_at: new Date().toISOString() };
  if (text.kind === "resolved") {
    const knownFields = { knife_count: text.count, contains_folding_knife: true as const, confidence: text.confidence, detection_source: "text" as const };
    if (item.shippingCost == null) {
      // eBay's search endpoint often omits a computed shipping cost for CALCULATED-shipping
      // listings. Rather than an instant reject, queue a follow-up per-item lookup — but only
      // when the price alone still leaves room to qualify, since shipping can only add cost.
      if (!isShippingLookupWorthwhile(item.itemPrice, text.count, maxCost)) {
        return { ...base, ...knownFields, status: "rejected", reason: "over_budget", processed_at: new Date().toISOString() };
      }
      return { ...base, ...knownFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
    }
    const deal = calculateDeal(item.itemPrice, item.shippingCost, text.count, maxCost);
    return { ...base, ...knownFields, status: deal.qualifies ? "qualified" : "rejected", reason: deal.reason, total_cost: "totalCost" in deal ? deal.totalCost : null, cost_per_knife: "costPerKnife" in deal ? deal.costPerKnife : null, processed_at: new Date().toISOString() };
  }
  if (!item.imageUrl) return { ...base, status: "rejected", reason: "missing_image", processed_at: new Date().toISOString() };
  return { ...base, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
}

type ExistingFinderRow = {
  ebay_item_id: string;
  knife_count: number | null;
  contains_folding_knife: boolean | null;
  confidence: number | null;
  detection_source: string | null;
  shipping_cost: number | string | null;
  shipping_source: string | null;
};

function refreshedRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, existing: ExistingFinderRow | undefined, maxCost: number) {
  // A calculated-shipping listing will keep returning a null shippingCost from eBay's search
  // endpoint forever, so once resolved via a per-item lookup, reuse it across refreshes instead
  // of re-spending an eBay call on the same listing every day.
  const preservedShipping = existing?.shipping_source === "lookup" && existing.shipping_cost != null;
  const effectiveItem = item.shippingCost == null && preservedShipping
    ? { ...item, shippingCost: Number(existing!.shipping_cost), shippingCurrency: "USD" }
    : item;
  const fresh = initialRow(effectiveItem, keywordPhrases, runId, maxCost);
  const freshRow = preservedShipping ? { ...fresh, shipping_source: "lookup" as const } : fresh;
  // Prefer fresh text-derived data whenever it has an opinion (finalized outright, or merely
  // awaiting a shipping lookup) — text is pattern-anchored and strictly more reliable than a
  // single-image vision call. Only fall back to a stale vision-derived count when today's text
  // re-analysis is still fully ambiguous, and this is what lets already-fixed parser bugs
  // self-correct for free on the next scan instead of staying wrong forever.
  if (!existing || existing.detection_source !== "vision" || existing.knife_count == null || freshRow.knife_count != null) return freshRow;
  const knownVisionFields = { knife_count: existing.knife_count, contains_folding_knife: existing.contains_folding_knife, confidence: existing.confidence, detection_source: "vision" as const };
  if (effectiveItem.shippingCost == null) {
    if (!isShippingLookupWorthwhile(effectiveItem.itemPrice, existing.knife_count, maxCost)) {
      return { ...freshRow, ...knownVisionFields, status: "rejected", reason: "over_budget", processed_at: new Date().toISOString() };
    }
    return { ...freshRow, ...knownVisionFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
  }
  const deal = calculateDeal(effectiveItem.itemPrice, effectiveItem.shippingCost, existing.knife_count, maxCost);
  return {
    ...freshRow,
    ...knownVisionFields,
    status: deal.qualifies ? "qualified" : "rejected",
    reason: deal.reason,
    total_cost: "totalCost" in deal ? deal.totalCost : null,
    cost_per_knife: "costPerKnife" in deal ? deal.costPerKnife : null,
    processed_at: new Date().toISOString(),
  };
}

async function updateRunCounts(runId: string) {
  const { data, error } = await supabaseAdmin.from("finder_items").select("status").eq("run_id", runId);
  if (error) throw new Error(error.message);
  const rows = data || [];
  const pending = rows.filter((row) => row.status === "pending").length;
  const qualified = rows.filter((row) => row.status === "qualified").length;
  const rejected = rows.filter((row) => row.status === "rejected" || row.status === "error").length;
  const values: Record<string, unknown> = { qualified, rejected };
  if (!pending) Object.assign(values, { status: "completed", completed_at: new Date().toISOString() });
  const { error: saveError } = await supabaseAdmin.from("finder_runs").update(values).eq("id", runId);
  if (saveError) throw new Error(saveError.message);
}

export async function startFinderRun(trigger: "scheduled" | "manual", runKey?: string) {
  const active = await findActiveRun();
  if (active) return { run: active, created: false };
  const key = runKey || `${trigger}:${trigger === "scheduled" ? easternDateKey() : randomUUID()}`;
  const { data: inserted, error: insertError } = await supabaseAdmin.from("finder_runs").upsert({ run_key: key, trigger }, { onConflict: "run_key", ignoreDuplicates: true }).select("*");
  if (insertError) throw new Error(insertError.message);
  if (!inserted?.length) {
    const { data: existing, error: existingError } = await supabaseAdmin.from("finder_runs").select("*").eq("run_key", key).single();
    if (existingError || !existing) throw new Error(existingError?.message || "Could not load existing finder run.");
    return { run: existing, created: false };
  }
  const run = inserted[0];
  try {
    const { data: keywords, error: keywordError } = await supabaseAdmin.from("finder_keywords").select("phrase, max_cost_per_knife").eq("enabled", true).order("created_at");
    if (keywordError) throw new Error(keywordError.message);
    const keywordMaxCost = new Map((keywords || []).map((keyword) => [keyword.phrase, keyword.max_cost_per_knife]));
    const found = new Map<string, { item: EbayFinderItem; phrases: string[] }>();
    const errors: string[] = [];
    let scanned = 0;
    const totalKeywords = keywords?.length || 0;
    // Fetch the eBay app token once and reuse it across every keyword search in this run —
    // fetching it fresh per keyword adds a whole extra network round trip per keyword, which
    // stacks up fast against this route's serverless time budget once there are 30+ keywords.
    const token = totalKeywords ? await appToken() : null;
    // Progress-write interval for the loop below: writing after every single keyword adds a
    // sequential DB round trip per keyword on top of the search itself, which used to be a
    // meaningful fraction of the whole scan's time once there were 30+ keywords. Every 5th
    // completion (plus always the last) keeps the "Searching X/Y" UI reasonably live without
    // paying for it on every keyword.
    const PROGRESS_WRITE_EVERY = 5;
    async function scanKeyword(keyword: { phrase: string; max_cost_per_knife?: number | null }) {
      try {
        for (const item of await searchEbayKeyword(keyword.phrase, config().searchDepth, token || undefined)) {
          const current = found.get(item.itemId);
          if (current) current.phrases.push(keyword.phrase);
          else found.set(item.itemId, { item, phrases: [keyword.phrase] });
        }
      } catch (error) { errors.push(error instanceof Error ? error.message : `Search failed for ${keyword.phrase}.`); }
      scanned++;
      if (scanned % PROGRESS_WRITE_EVERY === 0 || scanned === totalKeywords) {
        await supabaseAdmin.from("finder_runs").update({ keywords_scanned: scanned, current_keyword: keyword.phrase }).eq("id", run.id);
      }
    }
    // Keyword searches run with bounded concurrency instead of one at a time — sequentially,
    // 30+ keywords (each up to 3 paginated eBay calls) risked exceeding the route's serverless
    // time budget before the scan even finished, which is exactly what left production runs
    // stuck at "running" with a partial keywords_scanned count and no way to retry that day.
    await mapWithConcurrency(keywords || [], config().scanConcurrency, scanKeyword);
    const ids = [...found.keys()];
    const existingById = new Map<string, ExistingFinderRow>();
    for (let index = 0; index < ids.length; index += 200) {
      const { data, error } = await supabaseAdmin.from("finder_items").select("ebay_item_id, knife_count, contains_folding_knife, confidence, detection_source, shipping_cost, shipping_source").in("ebay_item_id", ids.slice(index, index + 200));
      if (error) throw new Error(error.message);
      for (const row of data || []) existingById.set(row.ebay_item_id, row);
    }
    const rows = [...found.values()].map(({ item, phrases }) => refreshedRow(item, phrases, run.id, existingById.get(item.itemId), resolveMaxCostPerKnife(phrases, keywordMaxCost, config().maxCost)));
    const added = ids.filter((id) => !existingById.has(id)).length;
    for (let index = 0; index < rows.length; index += 200) {
      const { error } = await supabaseAdmin.from("finder_items").upsert(rows.slice(index, index + 200), { onConflict: "ebay_item_id" });
      if (error) throw new Error(error.message);
    }
    await supabaseAdmin.from("finder_runs").update({ keywords_scanned: keywords?.length || 0, current_keyword: null, items_seen: found.size, items_added: added, errors }).eq("id", run.id);
    await updateRunCounts(run.id);
    await notifyNewlyQualified(rows.filter((row) => row.status === "qualified").map((row) => row.ebay_item_id));
    const { data: refreshed } = await supabaseAdmin.from("finder_runs").select("*").eq("id", run.id).single();
    return { run: refreshed, created: true };
  } catch (error) {
    await supabaseAdmin.from("finder_runs").update({ status: "failed", errors: [error instanceof Error ? error.message : "Finder run failed."], completed_at: new Date().toISOString() }).eq("id", run.id);
    throw error;
  }
}

export async function processPendingFinderItems(limit = config().batchSize) {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from("finder_items").select("*").eq("status", "pending").lte("next_attempt_at", now).order("discovered_at").limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data || []) as FinderRow[];
  const phraseSet = [...new Set(rows.flatMap((row) => row.keyword_phrases || []))];
  const keywordMaxCost = new Map<string, number | null>();
  if (phraseSet.length) {
    const { data: keywordRows, error: keywordError } = await supabaseAdmin.from("finder_keywords").select("phrase, max_cost_per_knife").in("phrase", phraseSet);
    if (keywordError) throw new Error(keywordError.message);
    for (const keywordRow of keywordRows || []) keywordMaxCost.set(keywordRow.phrase, keywordRow.max_cost_per_knife);
  }
  let processed = 0;
  let deferred = 0;
  const runIds = new Set<string>();
  const qualifiedIds: string[] = [];
  // Shared across every shipping lookup in this batch. Caching the in-flight *promise* (rather
  // than checking-then-awaiting-then-caching the resolved value) is what makes this safe under
  // concurrency: tokenForLookup runs fully synchronously up to the point it returns, so two rows
  // racing for the token can never both see it unset and each fire their own OAuth round trip.
  let tokenPromise: Promise<string> | undefined;
  const tokenForLookup = () => { if (!tokenPromise) tokenPromise = appToken(); return tokenPromise; };
  // Once Gemini's quota/budget is exhausted, every further vision call in this batch would just
  // 429 again — pointless. But shipping-only rows (row.knife_count already known) never touch
  // Gemini at all, so they must keep processing regardless; only skip the *vision* attempts.
  // Concurrent rows may each independently discover the exhaustion (the reservation itself is
  // enforced atomically server-side via the reserve_finder_vision_usage RPC) — that's fine, this
  // flag only short-circuits rows that haven't started yet by the time it's set.
  let visionExhaustedMessage: string | null = null;
  async function processRow(row: FinderRow) {
    if (row.run_id) runIds.add(row.run_id);
    const maxCost = resolveMaxCostPerKnife(row.keyword_phrases || [], keywordMaxCost, config().maxCost);
    try {
      if (row.knife_count != null) {
        // The text parser already resolved the count on discovery; this row is only pending
        // because the search result was missing a shipping cost, and initialRow already
        // confirmed the price alone leaves room to qualify — no need to touch Gemini at all.
        const shipping = await getItemShippingCost(row.ebay_item_id, await tokenForLookup());
        const shippingValue = shipping.value != null && (shipping.currency === "" || shipping.currency === "USD") ? shipping.value : null;
        const deal = shippingValue != null ? calculateDeal(Number(row.item_price), shippingValue, row.knife_count, maxCost) : null;
        const qualifies = Boolean(deal?.qualifies);
        const reason = shippingValue == null ? "missing_shipping" : deal?.reason;
        const { error: saveError } = await supabaseAdmin.from("finder_items").update({ status: qualifies ? "qualified" : "rejected", reason, shipping_cost: shippingValue, shipping_source: shippingValue != null ? "lookup" : null, total_cost: deal && "totalCost" in deal ? deal.totalCost : null, cost_per_knife: deal && "costPerKnife" in deal ? deal.costPerKnife : null, attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString() }).eq("ebay_item_id", row.ebay_item_id);
        if (saveError) throw new Error(saveError.message);
        if (qualifies) qualifiedIds.push(row.ebay_item_id);
        processed++;
        return;
      }
      if (visionExhaustedMessage) {
        await supabaseAdmin.from("finder_items").update({ next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), reason: visionExhaustedMessage }).eq("ebay_item_id", row.ebay_item_id);
        deferred++;
        return;
      }
      const vision = await countKnivesWithGemini({ title: row.title, description: row.short_description, imageUrl: row.image_url || "" });
      const confident = vision.confidence >= config().confidence && vision.knifeCount > 0 && vision.knifeCount <= FINDER_DEFAULTS.maxPlausibleKnifeCount && vision.containsFoldingKnife;
      let shippingValue = row.shipping_cost == null ? null : Number(row.shipping_cost);
      let shippingSource = row.shipping_source;
      let shippingReason: string | null = null;
      if (confident && shippingValue == null) {
        if (!isShippingLookupWorthwhile(Number(row.item_price), vision.knifeCount, maxCost)) {
          shippingReason = "over_budget";
        } else {
          const shipping = await getItemShippingCost(row.ebay_item_id, await tokenForLookup());
          if (shipping.value != null && (shipping.currency === "" || shipping.currency === "USD")) { shippingValue = shipping.value; shippingSource = "lookup"; }
          else shippingReason = "missing_shipping";
        }
      }
      const deal = confident && shippingValue != null ? calculateDeal(Number(row.item_price), shippingValue, vision.knifeCount, maxCost) : null;
      const qualifies = Boolean(confident && deal?.qualifies);
      const reason = !vision.containsFoldingKnife ? "no_folding_knife" : vision.confidence < config().confidence ? (vision.uncertaintyReason || "low_confidence") : vision.knifeCount < 1 ? "invalid_count" : vision.knifeCount > FINDER_DEFAULTS.maxPlausibleKnifeCount ? "implausible_count" : shippingReason ? shippingReason : deal?.reason;
      const { error: saveError } = await supabaseAdmin.from("finder_items").update({ status: qualifies ? "qualified" : "rejected", reason, knife_count: vision.knifeCount || null, contains_folding_knife: vision.containsFoldingKnife, confidence: vision.confidence, detection_source: "vision", shipping_cost: shippingValue, shipping_source: shippingValue != null ? shippingSource : null, total_cost: deal && "totalCost" in deal ? deal.totalCost : null, cost_per_knife: deal && "costPerKnife" in deal ? deal.costPerKnife : null, attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString() }).eq("ebay_item_id", row.ebay_item_id);
      if (saveError) throw new Error(saveError.message);
      if (qualifies) qualifiedIds.push(row.ebay_item_id);
      processed++;
    } catch (itemError) {
      if (itemError instanceof VisionQuotaError || itemError instanceof VisionBudgetError) {
        await supabaseAdmin.from("finder_items").update({ next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), reason: itemError.message }).eq("ebay_item_id", row.ebay_item_id);
        deferred++;
        visionExhaustedMessage = itemError.message;
        return;
      }
      const attempts = row.attempts + 1;
      await supabaseAdmin.from("finder_items").update({ status: attempts >= 3 ? "error" : "pending", reason: itemError instanceof Error ? itemError.message : "Vision analysis failed.", attempts, next_attempt_at: attempts >= 3 ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString(), processed_at: attempts >= 3 ? new Date().toISOString() : null }).eq("ebay_item_id", row.ebay_item_id);
    }
  }
  // Bounded concurrency instead of one row at a time — sequentially, at the old batchSize of 5
  // this queue drained at 5 items/minute (one tick), which took hours against a backlog in the
  // thousands. Each row's Gemini/eBay calls and DB writes are independent by ebay_item_id, so
  // running several at once is safe; the shared token and vision-exhaustion flag above are the
  // only cross-row state, and both are written synchronously with no await in between.
  await mapWithConcurrency(rows, config().processConcurrency, processRow);
  for (const runId of runIds) await updateRunCounts(runId);
  await notifyNewlyQualified(qualifiedIds);
  return { processed, deferred };
}

export async function finderTick(date = new Date()) {
  let dailyRun = null;
  if (isDailyFinderHour(date)) dailyRun = await startFinderRun("scheduled", `scheduled:${easternDateKey(date)}`);
  const queue = await processPendingFinderItems();
  return { dailyRun, queue };
}

export async function finderOverview() {
  const [keywords, results, runs, pending, rejected, qualified, usage] = await Promise.all([
    supabaseAdmin.from("finder_keywords").select("*").order("created_at"),
    supabaseAdmin.from("finder_items").select("*").eq("status", "qualified").is("dismissed_at", null).order("discovered_at", { ascending: false }).limit(500),
    supabaseAdmin.from("finder_runs").select("*").order("started_at", { ascending: false }).limit(10),
    supabaseAdmin.from("finder_items").select("ebay_item_id", { count: "exact", head: true }).eq("status", "pending"),
    supabaseAdmin.from("finder_items").select("ebay_item_id", { count: "exact", head: true }).in("status", ["rejected", "error"]),
    supabaseAdmin.from("finder_items").select("ebay_item_id", { count: "exact", head: true }).eq("status", "qualified").is("dismissed_at", null),
    supabaseAdmin.from("finder_vision_usage").select("*").eq("month", monthKey()).maybeSingle(),
  ]);
  const firstError = [keywords.error, results.error, runs.error, pending.error, rejected.error, qualified.error, usage.error].find(Boolean);
  if (firstError) throw new Error(firstError.message);
  const paid = Number(usage.data?.paid_analyses || 0);
  return {
    keywords: keywords.data || [], results: results.data || [], runs: runs.data || [],
    counts: { pending: pending.count || 0, rejected: rejected.count || 0, qualified: qualified.count || 0 },
    budget: { mode: process.env.GEMINI_PAID_MODE === "true" ? "paid" : "free", paidAnalyses: paid, monthlyLimit: config().monthlyLimit, remaining: Math.max(0, config().monthlyLimit - paid), projectedMaximum: paid * 0.001 },
    settings: { zip: process.env.EBAY_FINDER_ZIP || FINDER_DEFAULTS.zip, maxCostPerKnife: config().maxCost },
  };
}

export async function archivedFinderItems() {
  const { data, error } = await supabaseAdmin.from("finder_items").select("*").eq("status", "qualified").not("dismissed_at", "is", null).order("dismissed_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return { results: data || [] };
}
