import { randomUUID } from "node:crypto";
import { searchEbayKeyword, type EbayFinderItem } from "./ebay-finder";
import { analyzeListingText, calculateDeal, FINDER_DEFAULTS, isDailyFinderHour, monthKey } from "./finder-core";
import { countKnivesWithGemini, VisionBudgetError, VisionQuotaError } from "./gemini-vision";
import { addSnipe } from "./gixen-client";
import { sendQualifiedItemsEmail } from "./finder-notify";
import { supabaseAdmin } from "./supabase-admin";

async function notifyNewlyQualified(ebayItemIds: string[]) {
  if (!ebayItemIds.length) return;
  const { data, error } = await supabaseAdmin
    .from("finder_items")
    .select("ebay_item_id, title, ebay_url, image_url, item_price, shipping_cost, total_cost, cost_per_knife, knife_count, notified_at, gixen_status")
    .eq("status", "qualified")
    .in("ebay_item_id", ebayItemIds);
  if (error || !data?.length) return;
  const unnotified = data.filter((row) => !row.notified_at);
  if (unnotified.length) {
    const emailResult = await sendQualifiedItemsEmail(unnotified);
    if (emailResult.ok) {
      await supabaseAdmin.from("finder_items").update({ notified_at: new Date().toISOString() }).in("ebay_item_id", unnotified.map((row) => row.ebay_item_id));
    }
  }
  const unsent = data.filter((row) => !row.gixen_status);
  for (const row of unsent) {
    const totalCost = row.total_cost != null ? Number(row.total_cost) : Number(row.item_price) + Number(row.shipping_cost || 0);
    const result = await addSnipe({ itemId: row.ebay_item_id, maxBid: totalCost });
    await supabaseAdmin.from("finder_items").update({
      gixen_status: result.ok ? "sent" : "failed",
      gixen_message: result.message,
      gixen_sent_at: result.ok ? new Date().toISOString() : null,
    }).eq("ebay_item_id", row.ebay_item_id);
  }
}

type FinderRow = {
  ebay_item_id: string;
  run_id: string | null;
  title: string;
  short_description: string;
  image_url: string | null;
  item_price: number | string;
  shipping_cost: number | string | null;
  status: string;
  attempts: number;
};

const config = () => ({
  maxCost: Number(process.env.EBAY_FINDER_MAX_PER_KNIFE || FINDER_DEFAULTS.maxCostPerKnife),
  confidence: Number(process.env.GEMINI_CONFIDENCE_THRESHOLD || FINDER_DEFAULTS.confidence),
  searchDepth: Number(process.env.EBAY_FINDER_RESULTS_PER_KEYWORD || FINDER_DEFAULTS.resultsPerKeyword),
  batchSize: Number(process.env.GEMINI_BATCH_SIZE || FINDER_DEFAULTS.batchSize),
  monthlyLimit: Number(process.env.GEMINI_MONTHLY_ANALYSIS_LIMIT || FINDER_DEFAULTS.monthlyPaidAnalysisLimit),
});

function easternDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function initialRow(item: EbayFinderItem, keywordPhrases: string[], runId: string) {
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
  if (item.shippingCost == null) return { ...base, status: "rejected", reason: "missing_shipping", processed_at: new Date().toISOString() };
  if (item.itemEndDate && new Date(item.itemEndDate).getTime() <= Date.now()) return { ...base, status: "rejected", reason: "ended", processed_at: new Date().toISOString() };
  const text = analyzeListingText(item.title, item.shortDescription);
  if (text.kind === "reject") return { ...base, status: "rejected", reason: text.reason, processed_at: new Date().toISOString() };
  if (text.kind === "resolved") {
    const deal = calculateDeal(item.itemPrice, item.shippingCost, text.count, config().maxCost);
    return { ...base, status: deal.qualifies ? "qualified" : "rejected", reason: deal.reason, knife_count: text.count, contains_folding_knife: true, confidence: text.confidence, detection_source: "text", total_cost: "totalCost" in deal ? deal.totalCost : null, cost_per_knife: "costPerKnife" in deal ? deal.costPerKnife : null, processed_at: new Date().toISOString() };
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
};

function refreshedRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, existing: ExistingFinderRow | undefined) {
  const fresh = initialRow(item, keywordPhrases, runId);
  if (!existing || existing.detection_source !== "vision" || existing.knife_count == null) return fresh;
  const deal = calculateDeal(item.itemPrice, item.shippingCost, existing.knife_count, config().maxCost);
  return {
    ...fresh,
    status: deal.qualifies ? "qualified" : "rejected",
    reason: deal.reason,
    knife_count: existing.knife_count,
    contains_folding_knife: existing.contains_folding_knife,
    confidence: existing.confidence,
    detection_source: "vision",
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
    const { data: keywords, error: keywordError } = await supabaseAdmin.from("finder_keywords").select("phrase").eq("enabled", true).order("created_at");
    if (keywordError) throw new Error(keywordError.message);
    const found = new Map<string, { item: EbayFinderItem; phrases: string[] }>();
    const errors: string[] = [];
    for (const keyword of keywords || []) {
      try {
        for (const item of await searchEbayKeyword(keyword.phrase, config().searchDepth)) {
          const current = found.get(item.itemId);
          if (current) current.phrases.push(keyword.phrase);
          else found.set(item.itemId, { item, phrases: [keyword.phrase] });
        }
      } catch (error) { errors.push(error instanceof Error ? error.message : `Search failed for ${keyword.phrase}.`); }
    }
    const ids = [...found.keys()];
    const existingById = new Map<string, ExistingFinderRow>();
    for (let index = 0; index < ids.length; index += 200) {
      const { data, error } = await supabaseAdmin.from("finder_items").select("ebay_item_id, knife_count, contains_folding_knife, confidence, detection_source").in("ebay_item_id", ids.slice(index, index + 200));
      if (error) throw new Error(error.message);
      for (const row of data || []) existingById.set(row.ebay_item_id, row);
    }
    const rows = [...found.values()].map(({ item, phrases }) => refreshedRow(item, phrases, run.id, existingById.get(item.itemId)));
    const added = ids.filter((id) => !existingById.has(id)).length;
    for (let index = 0; index < rows.length; index += 200) {
      const { error } = await supabaseAdmin.from("finder_items").upsert(rows.slice(index, index + 200), { onConflict: "ebay_item_id" });
      if (error) throw new Error(error.message);
    }
    await supabaseAdmin.from("finder_runs").update({ keywords_scanned: keywords?.length || 0, items_seen: found.size, items_added: added, errors }).eq("id", run.id);
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
  let processed = 0;
  let deferred = 0;
  const runIds = new Set<string>();
  const qualifiedIds: string[] = [];
  for (const row of (data || []) as FinderRow[]) {
    if (row.run_id) runIds.add(row.run_id);
    try {
      const vision = await countKnivesWithGemini({ title: row.title, description: row.short_description, imageUrl: row.image_url || "" });
      const confident = vision.confidence >= config().confidence && vision.knifeCount > 0 && vision.containsFoldingKnife;
      const deal = confident ? calculateDeal(Number(row.item_price), row.shipping_cost == null ? null : Number(row.shipping_cost), vision.knifeCount, config().maxCost) : null;
      const qualifies = Boolean(confident && deal?.qualifies);
      const reason = !vision.containsFoldingKnife ? "no_folding_knife" : vision.confidence < config().confidence ? (vision.uncertaintyReason || "low_confidence") : vision.knifeCount < 1 ? "invalid_count" : deal?.reason;
      const { error: saveError } = await supabaseAdmin.from("finder_items").update({ status: qualifies ? "qualified" : "rejected", reason, knife_count: vision.knifeCount || null, contains_folding_knife: vision.containsFoldingKnife, confidence: vision.confidence, detection_source: "vision", total_cost: deal && "totalCost" in deal ? deal.totalCost : null, cost_per_knife: deal && "costPerKnife" in deal ? deal.costPerKnife : null, attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString() }).eq("ebay_item_id", row.ebay_item_id);
      if (saveError) throw new Error(saveError.message);
      if (qualifies) qualifiedIds.push(row.ebay_item_id);
      processed++;
    } catch (itemError) {
      if (itemError instanceof VisionQuotaError || itemError instanceof VisionBudgetError) {
        await supabaseAdmin.from("finder_items").update({ next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), reason: itemError.message }).eq("ebay_item_id", row.ebay_item_id);
        deferred++;
        break;
      }
      const attempts = row.attempts + 1;
      await supabaseAdmin.from("finder_items").update({ status: attempts >= 3 ? "error" : "pending", reason: itemError instanceof Error ? itemError.message : "Vision analysis failed.", attempts, next_attempt_at: attempts >= 3 ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString(), processed_at: attempts >= 3 ? new Date().toISOString() : null }).eq("ebay_item_id", row.ebay_item_id);
    }
  }
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
