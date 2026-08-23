import { randomUUID } from "node:crypto";
import { appToken, getItemDescription, getItemShippingCost, searchEbayByImage, searchEbayCategoryNewlyListed, searchEbayKeyword, type EbayFinderItem } from "./ebay-finder";
import { analyzeListingText, calculateDeal, dayKey, effectiveMaxCostPerKnife, FINDER_DEFAULTS, isScheduledRunTime, isShippingLookupWorthwhile, monthKey, resolveMaxCostPerKnife, type FinderScheduleSettings } from "./finder-core";
import { countKnivesWithGemini, VisionBudgetError, VisionQuotaError } from "./gemini-vision";
import {
  analyzeCarvingSetWithGemini,
  carvingSetCeiling,
  carvingSetGroupForPhrases,
  CARVING_SET_CATEGORY_BROWSE_LIMIT,
  CARVING_SET_CATEGORY_BROWSE_PHRASE,
  CARVING_SET_CATEGORY_ID,
  CARVING_SET_MODERN_ORIGIN_EXCLUDE_TERMS,
  CARVING_SET_PHRASES,
  CARVING_SET_USED_CONDITION_ID,
  decideCarvingSetFromText,
  evaluateCarvingSetVision,
  refreshedCarvingSetRow,
  type CarvingSetExistingRow,
  type CarvingSetGroup,
} from "./carving-set-finder";
import {
  analyzeGauchoKnifeMatch,
  gauchoKnifeGroupForPhrases,
  imageSearchPhrase,
  matchesNegativeKeyword,
  referenceImageBase64,
  refreshedGauchoKnifeRow,
  type GauchoKnifeExistingRow,
} from "./gaucho-knife-finder";
import { isAuctionFormat } from "./gixen-client";
import { sendQualifiedItemsEmail, sendRunSummaryEmail } from "./finder-notify";
import { supabaseAdmin } from "./supabase-admin";

// The three independent operational tracks staff run/review separately (see
// lib/carving-set-finder.ts/lib/gaucho-knife-finder.ts for how a keyword phrase resolves to
// "carving_set"/"gaucho_knife" — anything else is "pocket_knife"). Threaded through
// startFinderRun/finderOverview/archivedFinderItems/notifyNewlyQualified so a manual run, a
// results/settings page, or a qualification email for one track never touches another's data.
export type FinderCategory = "pocket_knife" | "carving_set" | "gaucho_knife";

export const FINDER_CATEGORIES = ["pocket_knife", "carving_set", "gaucho_knife"] as const;
export function isFinderCategory(value: unknown): value is FinderCategory {
  return typeof value === "string" && (FINDER_CATEGORIES as readonly string[]).includes(value);
}

// The single canonical classifier for "which of the three tracks does this finder_keywords phrase
// belong to" — every other definition of this test (startFinderRun's scoped-keyword filter,
// finderOverview's per-category keyword list, debugFindItemAcrossKeywords) must call this rather
// than re-implementing the carving-then-gaucho-else-pocket precedence inline, so a future edit to
// one category's phrase detection can't silently drift out of sync with another's and reopen a
// cross-finder mixing bug.
export function keywordCategory(phrase: string): FinderCategory {
  if (carvingSetGroupForPhrases([phrase])) return "carving_set";
  if (gauchoKnifeGroupForPhrases([phrase])) return "gaucho_knife";
  return "pocket_knife";
}

// Postgres array-literal elements containing whitespace (both our carving-set phrases do) must be
// double-quoted, or the server rejects the value outright ("malformed array literal"). supabase-js's
// own `.overlaps(col, array)` skips this quoting (`ov.{${array.join(",")}}`), and its generic
// `.not(col, op, array)` escape hatch does no array formatting at all — just String(array), which
// drops the required `{}` wrapper entirely. Build the literal ourselves and pass it as a string to
// sidestep both.
function pgTextArrayLiteral(values: string[]) {
  return `{${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scopeToCategory<Q extends { overlaps: (col: string, val: string) => any; not: (col: string, op: string, val: string) => any; eq: (col: string, val: string) => any; or: (val: string) => any }>(query: Q, category?: FinderCategory) {
  if (!category) return query;
  if (category === "carving_set") return query.overlaps("keyword_phrases", pgTextArrayLiteral(CARVING_SET_PHRASES));
  // Image-search-discovered gaucho items carry a synthetic "__image_search:<id>__" phrase (see
  // lib/gaucho-knife-finder.ts's imageSearchPhrase) rather than one of GAUCHO_KNIFE_PHRASES, and
  // Postgres array operators can't prefix-match an array element — so this scopes by
  // item_category instead, which initialGauchoKnifeRow sets to "gaucho_knife" unconditionally on
  // every row (unlike pocket_knife's item_category, which is null for a plain non-Swiss-Army
  // knife), regardless of which discovery path found it.
  if (category === "gaucho_knife") return query.eq("item_category", "gaucho_knife");
  // pocket_knife: neither a carving-set phrase nor a gaucho_knife item_category. The `.or` clause
  // must explicitly include NULL — a plain `.neq("item_category", "gaucho_knife")` would silently
  // exclude every ordinary pocket-knife row (item_category is null for those), since SQL's `<>`
  // against NULL evaluates to NULL/false, not true.
  return query.not("keyword_phrases", "ov", pgTextArrayLiteral(CARVING_SET_PHRASES)).or("item_category.is.null,item_category.neq.gaucho_knife");
}

type FinderNotifyMode = "auctions_only" | "all_qualified";

export async function getNotifySettings(): Promise<{ mode: FinderNotifyMode; recipients: string[] }> {
  const [settingsResult, recipientsResult] = await Promise.all([
    supabaseAdmin.from("finder_notify_settings").select("notify_mode").eq("id", true).maybeSingle(),
    supabaseAdmin.from("finder_notify_recipients").select("email").order("created_at"),
  ]);
  const mode: FinderNotifyMode = settingsResult.data?.notify_mode === "all_qualified" ? "all_qualified" : "auctions_only";
  const dbRecipients = (recipientsResult.data || []).map((row) => row.email as string);
  const recipients = dbRecipients.length
    ? dbRecipients
    : (process.env.FINDER_ALERT_EMAILS || "").split(",").map((address) => address.trim()).filter(Boolean);
  return { mode, recipients };
}

// Records the outcome of every real alert-email send attempt (not the "nothing to send"
// early-outs in notifyBucket) so a total SMTP failure is visible on /staff/finder/settings
// and in logs instead of silently leaving every qualified item unnotified forever, which is
// exactly what happened undetected for weeks before this existed.
export async function recordNotifyAttempt(result: { ok: boolean; message?: string }) {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { id: true, last_attempt_at: now, last_error: result.ok ? null : result.message || "Sending the alert email failed.", updated_at: now };
  if (result.ok) patch.last_success_at = now;
  await supabaseAdmin.from("finder_notify_settings").upsert(patch, { onConflict: "id" });
}

// Matches today's hardcoded default (daily at 6am America/New_York) — used only if a category's
// row is somehow missing (it's seeded by supabase/migrations/022_finder_schedule_settings.sql).
const DEFAULT_SCHEDULE: FinderScheduleSettings = { enabled: true, frequency: "daily", hour: 6, minute: 0, dayOfWeek: null };

async function getScheduleSettings(category: FinderCategory): Promise<FinderScheduleSettings> {
  const { data } = await supabaseAdmin.from("finder_schedule_settings").select("*").eq("category", category).maybeSingle();
  if (!data) return DEFAULT_SCHEDULE;
  return {
    enabled: Boolean(data.enabled),
    frequency: data.frequency === "weekly" ? "weekly" : "daily",
    hour: Number(data.run_hour),
    minute: Number(data.run_minute),
    dayOfWeek: data.day_of_week == null ? null : Number(data.day_of_week),
  };
}

export async function updateScheduleSettings(category: FinderCategory, patch: Partial<{ enabled: boolean; frequency: "daily" | "weekly"; hour: number; minute: number; dayOfWeek: number | null }>) {
  const values: Record<string, unknown> = { category, updated_at: new Date().toISOString() };
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.frequency !== undefined) values.frequency = patch.frequency;
  if (patch.hour !== undefined) values.run_hour = patch.hour;
  if (patch.minute !== undefined) values.run_minute = patch.minute;
  if (patch.dayOfWeek !== undefined) values.day_of_week = patch.dayOfWeek;
  const { error } = await supabaseAdmin.from("finder_schedule_settings").upsert(values, { onConflict: "category" });
  if (error) throw new Error(error.message);
}

type PocketKnifeSettings = { maxCostPerKnife: number };

// Matches FINDER_DEFAULTS.maxCostPerKnife — used only if the singleton row is somehow missing
// (it's seeded by supabase/migrations/034_finder_pocket_knife_settings.sql).
const DEFAULT_POCKET_KNIFE_SETTINGS: PocketKnifeSettings = { maxCostPerKnife: FINDER_DEFAULTS.maxCostPerKnife };

// The pocket-knife pipeline's global default max-cost-per-knife ceiling (the fallback used when no
// matched keyword has its own finder_keywords.max_cost_per_knife override) — a staff-editable app
// setting (see /staff/finder/settings) rather than an env var, so it can be tuned without a
// redeploy. Carving-set/gaucho-knife qualification never reads this; each of those has its own,
// unrelated pricing logic.
async function getPocketKnifeSettings(): Promise<PocketKnifeSettings> {
  const { data } = await supabaseAdmin.from("finder_pocket_knife_settings").select("*").eq("id", true).maybeSingle();
  if (!data) return DEFAULT_POCKET_KNIFE_SETTINGS;
  return { maxCostPerKnife: Number(data.max_cost_per_knife) };
}

export async function updatePocketKnifeSettings(patch: Partial<PocketKnifeSettings>) {
  if (patch.maxCostPerKnife === undefined) return;
  if (!Number.isFinite(patch.maxCostPerKnife) || patch.maxCostPerKnife <= 0) throw new Error("Enter a valid per-knife price greater than 0.");
  const { error } = await supabaseAdmin.from("finder_pocket_knife_settings").upsert({ id: true, max_cost_per_knife: patch.maxCostPerKnife, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

type NotifyRow = {
  ebay_item_id: string; title: string; ebay_url: string; image_url: string | null; item_price: number; shipping_cost: number | null;
  total_cost: number | null; cost_per_knife: number | null; knife_count: number | null; notified_at: string | null; gixen_status: string | null;
  buying_options: string[]; keyword_phrases: string[] | null; carving_piece_count: number | null; carving_has_case: boolean | null; carving_carbon_steel: boolean | null;
  gaucho_match_confidence?: number | string | null; gaucho_maker_match?: boolean | null; gaucho_match_notes?: string | null;
};

// Sends the qualified-item alert email for one category's bucket of rows, using the shared
// (not category-scoped) notify mode/recipients — staff chose to keep those settings global while
// still requiring the emails themselves to never mix pocket-knife and carving-set items.
async function notifyBucket(rows: NotifyRow[], mode: FinderNotifyMode, recipients: string[], kind: FinderCategory) {
  const unnotified = rows.filter((row) => !row.notified_at);
  if (!unnotified.length) return;
  if (mode === "all_qualified") {
    const auctionCount = unnotified.filter((row) => isAuctionFormat(row.buying_options)).length;
    const emailResult = await sendRunSummaryEmail(
      { total: unnotified.length, auctionCount, fixedPriceCount: unnotified.length - auctionCount },
      recipients,
      kind,
    );
    await recordNotifyAttempt(emailResult);
    if (emailResult.ok) {
      await supabaseAdmin.from("finder_items").update({ notified_at: new Date().toISOString() }).in("ebay_item_id", unnotified.map((row) => row.ebay_item_id));
    } else {
      console.error(`[finder-notify] Failed to send ${kind} summary email for ${unnotified.length} item(s): ${emailResult.message}`);
    }
    return;
  }
  const unnotifiedAuctions = unnotified.filter((row) => isAuctionFormat(row.buying_options));
  if (!unnotifiedAuctions.length) return;
  const emailResult = await sendQualifiedItemsEmail(unnotifiedAuctions, recipients, kind);
  await recordNotifyAttempt(emailResult);
  if (emailResult.ok) {
    await supabaseAdmin.from("finder_items").update({ notified_at: new Date().toISOString() }).in("ebay_item_id", unnotifiedAuctions.map((row) => row.ebay_item_id));
  } else {
    console.error(`[finder-notify] Failed to send ${kind} qualified-item email for ${unnotifiedAuctions.length} item(s): ${emailResult.message}`);
  }
}

async function notifyNewlyQualified(ebayItemIds: string[]) {
  if (!ebayItemIds.length) return;
  const { data, error } = await supabaseAdmin
    .from("finder_items")
    .select("ebay_item_id, title, ebay_url, image_url, item_price, shipping_cost, total_cost, cost_per_knife, knife_count, notified_at, gixen_status, buying_options, keyword_phrases, carving_piece_count, carving_has_case, carving_carbon_steel, carving_handle_material, gaucho_match_confidence, gaucho_maker_match, gaucho_match_notes")
    .eq("status", "qualified")
    .in("ebay_item_id", ebayItemIds);
  if (error || !data?.length) return;
  const { mode, recipients } = await getNotifySettings();
  // Split by category before sending — a single run/batch that qualifies items across multiple
  // categories must never combine them into one email, even though the notify mode and recipient
  // list are the same shared settings for all three.
  const carvingRows = data.filter((row) => carvingSetGroupForPhrases(row.keyword_phrases || []));
  const gauchoRows = data.filter((row) => gauchoKnifeGroupForPhrases(row.keyword_phrases || []));
  const pocketRows = data.filter((row) => !carvingSetGroupForPhrases(row.keyword_phrases || []) && !gauchoKnifeGroupForPhrases(row.keyword_phrases || []));
  await notifyBucket(pocketRows, mode, recipients, "pocket_knife");
  await notifyBucket(carvingRows, mode, recipients, "carving_set");
  await notifyBucket(gauchoRows, mode, recipients, "gaucho_knife");
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
  item_category: string | null;
  status: string;
  attempts: number;
  carving_piece_count: number | null;
  carving_has_case: boolean | null;
  carving_carbon_steel: boolean | null;
  carving_handle_material: "stag" | "ivory" | "other" | null;
};

// Categories that never qualify, at any price, regardless of which stage (text or vision)
// classified them. swiss_army_multi_tool is deliberately absent — it's allowed through at the
// stricter cap enforced by effectiveMaxCostPerKnife instead of being rejected outright.
// table_cutlery guards against a real Gemini vision failure mode: flatware/silverware lots
// (table knife + fork + spoon place settings) were being confirmed as containsFoldingKnife: true
// with itemCategory "other" — which isn't a garbage category — so they qualified with the whole
// piece count (forks and spoons included) counted as the knife count. Keeping this as an explicit
// category-based reject means a future vision misfire on containsFoldingKnife can't alone
// re-open this hole, as long as the category call itself lands correctly.
const GARBAGE_CATEGORIES = new Set(["multi_tool", "plain_blade", "credit_card_knife", "coin_knife", "box_cutter", "throwing_knife", "keychain_knife", "table_cutlery"]);

const config = () => {
  const monthlyLimit = Number(process.env.GEMINI_MONTHLY_ANALYSIS_LIMIT || FINDER_DEFAULTS.monthlyAnalysisLimit);
  return {
    swissArmyMaxCost: Number(process.env.EBAY_FINDER_SWISS_ARMY_MAX_PER_KNIFE || FINDER_DEFAULTS.swissArmyMaxCostPerKnife),
    confidence: Number(process.env.GEMINI_CONFIDENCE_THRESHOLD || FINDER_DEFAULTS.confidence),
    searchDepth: Number(process.env.EBAY_FINDER_RESULTS_PER_KEYWORD || FINDER_DEFAULTS.resultsPerKeyword),
    batchSize: Number(process.env.GEMINI_BATCH_SIZE || FINDER_DEFAULTS.batchSize),
    processConcurrency: Number(process.env.FINDER_PROCESS_CONCURRENCY || FINDER_DEFAULTS.processConcurrency),
    scanConcurrency: Number(process.env.EBAY_FINDER_SCAN_CONCURRENCY || FINDER_DEFAULTS.scanConcurrency),
    monthlyLimit,
    // Mirrors the default in gemini-vision.ts's dailyLimit(): spreads the monthly cap evenly
    // across a 30-day month unless GEMINI_DAILY_ANALYSIS_LIMIT overrides it directly.
    dailyLimit: Number(process.env.GEMINI_DAILY_ANALYSIS_LIMIT || Math.ceil(monthlyLimit / 30)),
  };
};

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

// How long a "running" finder_runs row is trusted to genuinely still be in progress before it's
// treated as orphaned (crashed or hit the route's serverless timeout mid-scan) and reconciled to
// "failed" by reconcileOrphanedRuns below. This only needs to cover the scan phase itself (see
// mapWithConcurrency above) — a genuine scan finishes in well under a minute — because
// updateRunCounts now finalizes a run as "completed" as soon as its scan is written, rather than
// waiting for every item it discovered to clear the (separately tracked) vision/shipping pending
// queue. That queue can legitimately take much longer than this window to drain — a single
// Gemini rate-limit hit defers a whole batch by an hour (see VisionQuotaError handling) — so it
// must never be what this window is measuring, or a perfectly healthy run gets flagged abandoned.
const RUN_LOCK_WINDOW_MS = 15 * 60 * 1000;

// Flips any "running" finder_runs row older than RUN_LOCK_WINDOW_MS to "failed". Without this, a
// run killed mid-scan by the route's serverless timeout (or a crash) stays "running" forever —
// completed_at is only ever set by updateRunCounts, which never runs again for a run whose own
// startFinderRun call never reached it — and the staff dashboard shows that stale row as "still
// going" indefinitely, with run_key's uniqueness blocking any retry for that day. Cheap to call
// on every tick: finder_runs has one row per day/manual-click, never enough to matter.
async function reconcileOrphanedRuns() {
  const cutoff = new Date(Date.now() - RUN_LOCK_WINDOW_MS).toISOString();
  const { data: stale, error } = await supabaseAdmin.from("finder_runs").select("id, errors").eq("status", "running").lte("started_at", cutoff);
  if (error) throw new Error(error.message);
  for (const row of stale || []) {
    const errors = [...(row.errors || []), "Abandoned: run stayed \"running\" past the lock window without completing (likely a serverless timeout mid-run)."];
    const { error: updateError } = await supabaseAdmin.from("finder_runs").update({ status: "failed", completed_at: new Date().toISOString(), errors }).eq("id", row.id);
    if (updateError) throw new Error(updateError.message);
  }
}

// A scoped (category-specific) run must never block, or be blocked by, a run of the OTHER
// category — but an unscoped run (category is null; today only the automated daily scan) touches
// every keyword, so it must still serialize against both. Passing no `category` here (the
// automated path) preserves today's behavior exactly: any running row blocks a new unscoped run.
async function findActiveRun(category?: FinderCategory) {
  await reconcileOrphanedRuns();
  let query = supabaseAdmin.from("finder_runs").select("*").eq("status", "running").order("started_at", { ascending: false }).limit(1);
  if (category) query = query.or(`category.is.null,category.eq.${category}`);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function easternDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function initialRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, maxCost: number, swissArmyMax: number) {
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
    const category = text.swissArmy ? "swiss_army_multi_tool" : null;
    const effectiveMax = effectiveMaxCostPerKnife(category, maxCost, swissArmyMax);
    const knownFields = { knife_count: text.count, contains_folding_knife: true as const, confidence: text.confidence, detection_source: "text" as const, item_category: category };
    if (item.shippingCost == null) {
      // eBay's search endpoint often omits a computed shipping cost for CALCULATED-shipping
      // listings. Rather than an instant reject, queue a follow-up per-item lookup — but only
      // when the price alone still leaves room to qualify, since shipping can only add cost.
      if (!isShippingLookupWorthwhile(item.itemPrice, text.count, effectiveMax)) {
        return { ...base, ...knownFields, status: "rejected", reason: "over_budget", processed_at: new Date().toISOString() };
      }
      return { ...base, ...knownFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
    }
    const deal = calculateDeal(item.itemPrice, item.shippingCost, text.count, effectiveMax);
    return { ...base, ...knownFields, status: deal.qualifies ? "qualified" : "rejected", reason: deal.reason, total_cost: "totalCost" in deal ? deal.totalCost : null, cost_per_knife: "costPerKnife" in deal ? deal.costPerKnife : null, processed_at: new Date().toISOString() };
  }
  if (!item.imageUrl) return { ...base, status: "rejected", reason: "missing_image", processed_at: new Date().toISOString() };
  return { ...base, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
}

type ExistingFinderRow = {
  ebay_item_id: string;
  keyword_phrases?: string[] | null;
  status?: string;
  reason?: string | null;
  knife_count: number | null;
  contains_folding_knife: boolean | null;
  confidence: number | null;
  detection_source: string | null;
  item_category: string | null;
  shipping_cost: number | string | null;
  shipping_source: string | null;
  carving_piece_count: number | null;
  carving_has_case: boolean | null;
  carving_carbon_steel: boolean | null;
  carving_handle_material: "stag" | "ivory" | "other" | null;
  gaucho_match_confidence?: number | string | null;
  gaucho_maker_match?: boolean | null;
  gaucho_matched_reference_id?: string | null;
  gaucho_match_notes?: string | null;
};

function refreshedRow(item: EbayFinderItem, keywordPhrases: string[], runId: string, existing: ExistingFinderRow | undefined, maxCost: number, swissArmyMax: number) {
  // A calculated-shipping listing will keep returning a null shippingCost from eBay's search
  // endpoint forever, so once resolved via a per-item lookup, reuse it across refreshes instead
  // of re-spending an eBay call on the same listing every day.
  const preservedShipping = existing?.shipping_source === "lookup" && existing.shipping_cost != null;
  const effectiveItem = item.shippingCost == null && preservedShipping
    ? { ...item, shippingCost: Number(existing!.shipping_cost), shippingCurrency: "USD" }
    : item;
  const fresh = initialRow(effectiveItem, keywordPhrases, runId, maxCost, swissArmyMax);
  const freshRow = preservedShipping ? { ...fresh, shipping_source: "lookup" as const } : fresh;
  // Prefer fresh text-derived data whenever it has an opinion (finalized outright, or merely
  // awaiting a shipping lookup) — text is pattern-anchored and strictly more reliable than a
  // single-image vision call. Only fall back to a stale vision-derived count when today's text
  // re-analysis is still fully ambiguous, and this is what lets already-fixed parser bugs
  // self-correct for free on the next scan instead of staying wrong forever.
  if (!existing || existing.detection_source !== "vision" || existing.knife_count == null || freshRow.knife_count != null) return freshRow;
  // Even when text still can't confirm the folding-knife signal on its own (e.g. a fixed-blade
  // "skinner"/"hunting knife" lot with no folding/brand wording), a title-stated count like
  // "lot of 15" is more reliable than a stale vision-derived count from the same listing's photo
  // (often a seller's whole catalog/stock shot, not this specific lot). Reusing the previously
  // confirmed classification (containsFoldingKnife/confidence/category) but correcting the count
  // this way needs no new Gemini call, and is a no-op whenever text and the stored count already
  // agree.
  const textAnalysis = analyzeListingText(effectiveItem.title, effectiveItem.shortDescription);
  const knownCount = textAnalysis.kind === "vision" ? textAnalysis.knownCount : undefined;
  const effectiveKnifeCount = knownCount ?? existing.knife_count;
  // A previously vision-classified garbage item (box cutter, plain blade, credit-card/coin knife,
  // non-Swiss-Army multi-tool) must stay rejected on refresh without re-running calculateDeal —
  // otherwise a stale garbage item could "re-qualify" purely because its price happens to look
  // good today, even though its category was never re-examined.
  if (existing.item_category && GARBAGE_CATEGORIES.has(existing.item_category)) {
    return { ...freshRow, item_category: existing.item_category, status: "rejected" as const, reason: existing.item_category, knife_count: effectiveKnifeCount, contains_folding_knife: existing.contains_folding_knife, confidence: existing.confidence, detection_source: "vision" as const, processed_at: new Date().toISOString() };
  }
  const effectiveMax = effectiveMaxCostPerKnife(existing.item_category, maxCost, swissArmyMax);
  const knownVisionFields = { knife_count: effectiveKnifeCount, contains_folding_knife: existing.contains_folding_knife, confidence: existing.confidence, detection_source: "vision" as const, item_category: existing.item_category };
  if (effectiveItem.shippingCost == null) {
    if (!isShippingLookupWorthwhile(effectiveItem.itemPrice, effectiveKnifeCount, effectiveMax)) {
      return { ...freshRow, ...knownVisionFields, status: "rejected", reason: "over_budget", processed_at: new Date().toISOString() };
    }
    return { ...freshRow, ...knownVisionFields, status: "pending", reason: null, next_attempt_at: new Date().toISOString() };
  }
  const deal = calculateDeal(effectiveItem.itemPrice, effectiveItem.shippingCost, effectiveKnifeCount, effectiveMax);
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

// Called once right after startFinderRun finishes writing its scan results, and again later
// whenever processPendingFinderItems resolves one of this run's items (it tracks run_id from
// whatever pending rows it happened to pick up, regardless of which run — or day — discovered
// them). Always finalizes the run as "completed": a run's own scan work is done by the time this
// is reachable at all, and leftover pending items are just background vision/shipping lookups
// that the "STILL CHECKING" counter already surfaces on its own — they must not keep the run row
// reading "running" while they drain, or a run with a real backlog (see the comment on
// RUN_LOCK_WINDOW_MS) gets wrongly reconciled as abandoned before it ever gets the chance.
async function updateRunCounts(runId: string) {
  const { data, error } = await supabaseAdmin.from("finder_items").select("status, first_seen_run_id, dismissed_at").eq("run_id", runId);
  if (error) throw new Error(error.message);
  const rows = data || [];
  const qualified = rows.filter((row) => row.status === "qualified").length;
  const rejected = rows.filter((row) => row.status === "rejected" || row.status === "error").length;
  // Distinct from `qualified` above (which includes days-old listings this run merely re-touched,
  // and doesn't exclude dismissed items) — this is the count the dashboard's "Found N good deals
  // among M new listings" sentence needs so its two numbers are actually related.
  const newQualified = rows.filter((row) => row.first_seen_run_id === runId && row.status === "qualified" && !row.dismissed_at).length;
  const { error: saveError } = await supabaseAdmin.from("finder_runs").update({ qualified, rejected, new_qualified: newQualified, status: "completed", completed_at: new Date().toISOString() }).eq("id", runId);
  if (saveError) throw new Error(saveError.message);
}

export async function startFinderRun(trigger: "scheduled" | "manual", runKey?: string, category?: FinderCategory) {
  const active = await findActiveRun(category);
  if (active) return { run: active, created: false };
  const key = runKey || `${trigger}:${trigger === "scheduled" ? easternDateKey() : randomUUID()}`;
  const { data: inserted, error: insertError } = await supabaseAdmin.from("finder_runs").upsert({ run_key: key, trigger, category: category ?? null }, { onConflict: "run_key", ignoreDuplicates: true }).select("*");
  if (insertError) throw new Error(insertError.message);
  if (!inserted?.length) {
    const { data: existing, error: existingError } = await supabaseAdmin.from("finder_runs").select("*").eq("run_key", key).single();
    if (existingError || !existing) throw new Error(existingError?.message || "Could not load existing finder run.");
    return { run: existing, created: false };
  }
  const run = inserted[0];
  try {
    const { data: allKeywords, error: keywordError } = await supabaseAdmin.from("finder_keywords").select("phrase, max_cost_per_knife").eq("enabled", true).order("created_at");
    if (keywordError) throw new Error(keywordError.message);
    const pocketKnifeSettings = await getPocketKnifeSettings();
    // No category column on finder_keywords — a scoped run filters in JS by whether each phrase
    // resolves to the carving-set/gaucho-knife algorithm, the same test the per-item dispatch
    // already uses (see keywordCategory above).
    // Fetched up front (not just inside the image-search block below) because it also gates the
    // gaucho keyword *supplement*: with zero reference photos configured, there's nothing for
    // Gemini to compare a candidate against, so this run should discover nothing at all for this
    // category — not queue up hundreds of listings destined to just sit deferred.
    const { data: gauchoReferenceImageRows, error: gauchoReferenceError } = (!category || category === "gaucho_knife")
      ? await supabaseAdmin.from("finder_reference_images").select("id, storage_path").eq("category", "gaucho_knife")
      : { data: null, error: null };
    if (gauchoReferenceError) throw new Error(gauchoReferenceError.message);
    const hasGauchoReferenceImages = Boolean(gauchoReferenceImageRows?.length);
    const errors: string[] = [];
    if (category === "gaucho_knife" && !hasGauchoReferenceImages) errors.push("No reference images are configured yet — upload at least one before running the gaucho-knife finder.");
    const keywords = (allKeywords || []).filter((keyword) => {
      const resolvedCategory = keywordCategory(keyword.phrase);
      if (resolvedCategory === "gaucho_knife" && !hasGauchoReferenceImages) return false;
      return category ? resolvedCategory === category : true;
    });
    const keywordMaxCost = new Map((keywords || []).map((keyword) => [keyword.phrase, keyword.max_cost_per_knife]));
    const found = new Map<string, { item: EbayFinderItem; phrases: string[] }>();
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
        const carvingGroup = carvingSetGroupForPhrases([keyword.phrase]);
        const extraExcludeTerms = carvingGroup ? CARVING_SET_MODERN_ORIGIN_EXCLUDE_TERMS : [];
        // Carving-set keywords are restricted to Used listings only (see
        // CARVING_SET_USED_CONDITION_ID) — this buyer wants antique cutlery, never new-made
        // reissues. Left unset for pocket-knife keywords, which keep searching every condition.
        const conditionId = carvingGroup ? CARVING_SET_USED_CONDITION_ID : undefined;
        for (const item of await searchEbayKeyword(keyword.phrase, config().searchDepth, token || undefined, extraExcludeTerms, conditionId)) {
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
    // Gaucho-knife discovery leads with eBay's searchByImage against every staff-uploaded
    // reference photo, unlike the other two categories, which discover purely by keyword — real
    // gaucho knives are routinely mislabeled by sellers who don't recognize what they have, so a
    // keyword-only search would miss exactly the listings this category exists to catch. Hits are
    // merged into the same `found` map, tagged with a synthetic phrase carrying which reference
    // image produced them (imageSearchPhrase) so category resolution and staff auditability both
    // still work. Skipped entirely with zero reference photos configured (hasGauchoReferenceImages,
    // computed above alongside the keyword filter) — there's nothing to search by.
    if (hasGauchoReferenceImages) {
      const referenceImages = gauchoReferenceImageRows || [];
      const imageToken = token || await appToken();
      async function scanReferenceImage(reference: { id: string; storage_path: string }) {
        try {
          const imageBase64 = await referenceImageBase64(reference.storage_path);
          const phrase = imageSearchPhrase(reference.id);
          // Used-only, same as the keyword-search supplement above — a genuine antique gaucho
          // knife is never a new-made reissue.
          for (const item of await searchEbayByImage(imageBase64, FINDER_DEFAULTS.imageSearchResultsPerReference, imageToken || undefined, CARVING_SET_USED_CONDITION_ID)) {
            const current = found.get(item.itemId);
            if (current) current.phrases.push(phrase);
            else found.set(item.itemId, { item, phrases: [phrase] });
          }
        } catch (error) { errors.push(error instanceof Error ? error.message : `Image search failed for reference ${reference.id}.`); }
      }
      await mapWithConcurrency(referenceImages || [], config().scanConcurrency, scanReferenceImage);
    }
    // The carving-set pipeline's "Flatware Sets" category browse (see CARVING_SET_CATEGORY_ID) is
    // not a text search, so it doesn't belong in scanKeyword's per-finder_keywords-row loop above —
    // it runs once per carving-set-scoped scan instead, independent of any keyword row.
    if (category === "carving_set") {
      try {
        for (const item of await searchEbayCategoryNewlyListed(CARVING_SET_CATEGORY_ID, CARVING_SET_CATEGORY_BROWSE_LIMIT, token || undefined, CARVING_SET_USED_CONDITION_ID)) {
          const current = found.get(item.itemId);
          if (current) current.phrases.push(CARVING_SET_CATEGORY_BROWSE_PHRASE);
          else found.set(item.itemId, { item, phrases: [CARVING_SET_CATEGORY_BROWSE_PHRASE] });
        }
      } catch (error) { errors.push(error instanceof Error ? error.message : "Flatware Sets category browse failed."); }
    }
    // Carving-set items' full eBay description used to be fetched here, eagerly, for every item
    // found — one network call per item, hundreds per run for a broad keyword like "carving set".
    // That reliably blew this route's 60-second serverless budget (Vercel's own platform limit,
    // not the app-level 15-minute finder_runs watchdog — see RUN_LOCK_WINDOW_MS above) whenever a
    // scan turned up enough items, which is exactly what left carving_set runs stuck "running"
    // with items_seen at 0 until the watchdog reconciled them as abandoned. The description fetch
    // (and the text re-check it enables) now happens lazily, per item, inside
    // processPendingFinderItems's processCarvingSetRow — the same incremental, tick-bounded queue
    // that already handles Gemini vision — so no single scan invocation's duration depends on how
    // many carving-set listings a keyword happens to match.
    const ids = [...found.keys()];
    const existingById = new Map<string, ExistingFinderRow>();
    for (let index = 0; index < ids.length; index += 200) {
      const { data, error } = await supabaseAdmin.from("finder_items").select("ebay_item_id, keyword_phrases, status, reason, knife_count, contains_folding_knife, confidence, detection_source, item_category, shipping_cost, shipping_source, carving_piece_count, carving_has_case, carving_carbon_steel, carving_handle_material, gaucho_match_confidence, gaucho_maker_match, gaucho_matched_reference_id, gaucho_match_notes").in("ebay_item_id", ids.slice(index, index + 200));
      if (error) throw new Error(error.message);
      for (const row of data || []) existingById.set(row.ebay_item_id, row);
    }
    const { data: negativeKeywordRows, error: negativeKeywordError } = await supabaseAdmin.from("finder_gaucho_negative_keywords").select("phrase").eq("enabled", true);
    if (negativeKeywordError) throw new Error(negativeKeywordError.message);
    const negativePhrases = (negativeKeywordRows || []).map((row) => row.phrase);
    const textRows = [...found.values()].map(({ item, phrases }) => {
      const existing = existingById.get(item.itemId);
      // A category-scoped run only ever searches its own keyword set (see the keywords filter
      // above), so `phrases` here is just what THIS scan matched — never the full history of what
      // every category's runs have matched over this item's lifetime. Merging in whatever was
      // already stored (rather than overwriting keyword_phrases outright) is what keeps a listing's
      // category classification stable once established: without this, an item first discovered
      // as a carving-set (or gaucho-knife) match could get silently reclassified as a plain pocket
      // knife the next time a differently-scoped run's keyword search happens to also match its
      // title/description — flipping which finder's dashboard, counts, and qualification emails it
      // shows up under. This is exactly the cross-finder "mixing" bug reported in production.
      const mergedPhrases = existing?.keyword_phrases?.length ? [...new Set([...existing.keyword_phrases, ...phrases])] : phrases;
      const carvingGroup = carvingSetGroupForPhrases(mergedPhrases);
      if (carvingGroup) return refreshedCarvingSetRow(item, mergedPhrases, run.id, existing as CarvingSetExistingRow | undefined, carvingGroup);
      if (gauchoKnifeGroupForPhrases(mergedPhrases)) return refreshedGauchoKnifeRow(item, mergedPhrases, run.id, existing as GauchoKnifeExistingRow | undefined, negativePhrases);
      return refreshedRow(item, mergedPhrases, run.id, existing, resolveMaxCostPerKnife(mergedPhrases, keywordMaxCost, pocketKnifeSettings.maxCostPerKnife), config().swissArmyMaxCost);
    });
    const added = ids.filter((id) => !existingById.has(id)).length;
    // Stamped only for genuinely new items (existingById already distinguishes new vs. re-touched,
    // same check `added` above uses) — never included for an already-known item, so the upsert's
    // conflict path leaves a previously-set value untouched. A DB trigger (see migration
    // 023_finder_items_first_seen_run_id.sql) backstops this for any other insert path, but setting
    // it explicitly here keeps the "new listing" distinction visible and testable at the call site.
    const rowsWithFirstSeen = textRows.map((row) => existingById.has(row.ebay_item_id) ? row : { ...row, first_seen_run_id: run.id });
    for (let index = 0; index < rowsWithFirstSeen.length; index += 200) {
      const { error } = await supabaseAdmin.from("finder_items").upsert(rowsWithFirstSeen.slice(index, index + 200), { onConflict: "ebay_item_id" });
      if (error) throw new Error(error.message);
    }
    await supabaseAdmin.from("finder_runs").update({ keywords_scanned: keywords?.length || 0, current_keyword: null, items_seen: found.size, items_added: added, errors }).eq("id", run.id);
    await updateRunCounts(run.id);
    await notifyNewlyQualified(textRows.filter((row) => row.status === "qualified").map((row) => row.ebay_item_id));
    const { data: refreshed } = await supabaseAdmin.from("finder_runs").select("*").eq("id", run.id).single();
    return { run: refreshed, created: true };
  } catch (error) {
    await supabaseAdmin.from("finder_runs").update({ status: "failed", errors: [error instanceof Error ? error.message : "Finder run failed."], completed_at: new Date().toISOString() }).eq("id", run.id);
    throw error;
  }
}

export type FinderKeywordProbe = { phrase: string; itemsReturned: number; hitResultsCap: boolean; found: boolean; matchedTitle: string | null; error: string | null };

// Standing diagnostic for "why didn't the finder pick up listing X" reports: independently of
// any finder_items row, re-runs every enabled keyword's live eBay search and checks whether the
// given item id (either the bare numeric eBay id or the full "v1|...|0" form) shows up in the
// raw results. Distinguishes "genuinely absent from the eBay Browse API's results" from "present,
// but the keyword search returned so many results it hit resultsPerKeyword before reaching it".
export async function debugFindItemAcrossKeywords(itemId: string): Promise<FinderKeywordProbe[]> {
  const { data: keywordRows, error: keywordError } = await supabaseAdmin.from("finder_keywords").select("phrase").eq("enabled", true).order("created_at");
  if (keywordError) throw new Error(keywordError.message);
  const keywords = keywordRows || [];
  const token = keywords.length ? await appToken() : null;
  async function probeKeyword(keyword: { phrase: string }): Promise<FinderKeywordProbe> {
    try {
      const carvingGroup = carvingSetGroupForPhrases([keyword.phrase]);
      const extraExcludeTerms = carvingGroup ? CARVING_SET_MODERN_ORIGIN_EXCLUDE_TERMS : [];
      const conditionId = carvingGroup ? CARVING_SET_USED_CONDITION_ID : undefined;
      const items = await searchEbayKeyword(keyword.phrase, config().searchDepth, token || undefined, extraExcludeTerms, conditionId);
      const match = items.find((item) => item.itemId.includes(itemId));
      return { phrase: keyword.phrase, itemsReturned: items.length, hitResultsCap: items.length >= config().searchDepth, found: Boolean(match), matchedTitle: match?.title ?? null, error: null };
    } catch (error) {
      return { phrase: keyword.phrase, itemsReturned: 0, hitResultsCap: false, found: false, matchedTitle: null, error: error instanceof Error ? error.message : "Search failed." };
    }
  }
  return mapWithConcurrency(keywords, config().scanConcurrency, probeKeyword);
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
  const pocketKnifeSettings = await getPocketKnifeSettings();
  // Fetched once for the whole batch, not per row — only needed at all when this batch actually
  // contains a gaucho-knife row.
  const gauchoNegativePhrases: string[] = [];
  const gauchoReferenceImages: { id: string; storagePath: string }[] = [];
  if (rows.some((row) => gauchoKnifeGroupForPhrases(row.keyword_phrases || []))) {
    const [negativeResult, referenceResult] = await Promise.all([
      supabaseAdmin.from("finder_gaucho_negative_keywords").select("phrase").eq("enabled", true),
      supabaseAdmin.from("finder_reference_images").select("id, storage_path").eq("category", "gaucho_knife"),
    ]);
    if (negativeResult.error) throw new Error(negativeResult.error.message);
    if (referenceResult.error) throw new Error(referenceResult.error.message);
    gauchoNegativePhrases.push(...(negativeResult.data || []).map((row) => row.phrase));
    gauchoReferenceImages.push(...(referenceResult.data || []).map((row) => ({ id: row.id, storagePath: row.storage_path })));
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
  // Carving-set rows never touch resolveMaxCostPerKnife/effectiveMaxCostPerKnife/calculateDeal or
  // countKnivesWithGemini — a wholly separate algorithm (lib/carving-set-finder.ts) decides their
  // ceiling and vision classification. They share only the generic batch-level plumbing below:
  // the shipping-lookup token cache and the cross-algorithm Gemini budget-exhaustion flag.
  async function processCarvingSetRow(row: FinderRow, group: CarvingSetGroup) {
    if (row.run_id) runIds.add(row.run_id);
    try {
      if (row.knife_count != null) {
        // Text already confirmed case/material/a usable ceiling on discovery; this row is only
        // pending because eBay's search result was missing a shipping cost.
        const ceiling = carvingSetCeiling(group, row.carving_piece_count);
        const shipping = await getItemShippingCost(row.ebay_item_id, await tokenForLookup());
        const shippingValue = shipping.value != null && (shipping.currency === "" || shipping.currency === "USD") ? shipping.value : null;
        const totalCost = shippingValue != null && ceiling != null ? Math.round((Number(row.item_price) + shippingValue) * 100) / 100 : null;
        const qualifies = totalCost != null && totalCost <= ceiling!;
        const reason = shippingValue == null ? "missing_shipping" : (qualifies ? null : "over_budget");
        const { error: saveError } = await supabaseAdmin.from("finder_items").update({ status: qualifies ? "qualified" : "rejected", reason, shipping_cost: shippingValue, shipping_source: shippingValue != null ? "lookup" : null, total_cost: totalCost, cost_per_knife: totalCost, attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString() }).eq("ebay_item_id", row.ebay_item_id);
        if (saveError) throw new Error(saveError.message);
        if (qualifies) qualifiedIds.push(row.ebay_item_id);
        processed++;
        return;
      }
      // The full eBay description used to be fetched eagerly for every carving-set item during
      // startFinderRun's scan; it's now fetched here instead, lazily and one row at a time, so no
      // single scan invocation's duration depends on how many listings a keyword happens to match
      // (see the comment above the removed scan-time fetch in startFinderRun). Re-running the text
      // decision against the enriched description first — before ever touching Gemini — often
      // resolves the row outright (the same benefit the eager fetch existed for), and always gives
      // vision better context on the description it does still need to fall through to.
      const description = await getItemDescription(row.ebay_item_id, await tokenForLookup());
      const textDecision = decideCarvingSetFromText(row.title, description, group, Number(row.item_price), row.shipping_cost == null ? null : Number(row.shipping_cost));
      if (textDecision.kind === "reject") {
        const { error: saveError } = await supabaseAdmin.from("finder_items").update({ status: "rejected", reason: textDecision.reason, item_category: "carving_set", carving_piece_count: textDecision.pieceCount, short_description: description, attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString() }).eq("ebay_item_id", row.ebay_item_id);
        if (saveError) throw new Error(saveError.message);
        processed++;
        return;
      }
      if (textDecision.kind === "resolved" || textDecision.kind === "needs-shipping") {
        let shippingValue = row.shipping_cost == null ? null : Number(row.shipping_cost);
        let shippingSource = row.shipping_source;
        let totalCost: number | null;
        let qualifies: boolean;
        let reason: string | null;
        if (textDecision.kind === "resolved") {
          totalCost = textDecision.totalCost;
          qualifies = textDecision.qualifies;
          reason = textDecision.reason;
        } else {
          const shipping = await getItemShippingCost(row.ebay_item_id, await tokenForLookup());
          if (shipping.value != null && (shipping.currency === "" || shipping.currency === "USD")) { shippingValue = shipping.value; shippingSource = "lookup"; }
          totalCost = shippingValue != null ? Math.round((Number(row.item_price) + shippingValue) * 100) / 100 : null;
          qualifies = totalCost != null && totalCost <= textDecision.ceiling;
          reason = shippingValue == null ? "missing_shipping" : (qualifies ? null : "over_budget");
        }
        const { error: saveError } = await supabaseAdmin.from("finder_items").update({
          status: qualifies ? "qualified" : "rejected", reason,
          knife_count: 1, contains_folding_knife: false, confidence: 0.95, detection_source: "text", item_category: "carving_set",
          // decideCarvingSetFromText's fast path only reaches "resolved"/"needs-shipping" once
          // text.handleMaterial === "stag" is already confirmed (it's German/generic-only, and
          // ivory is never acceptable for those groups), so carving_handle_material is always
          // "stag" here, same as carving_has_case being always true.
          carving_piece_count: textDecision.pieceCount, carving_has_case: true, carving_carbon_steel: null, carving_handle_material: "stag",
          shipping_cost: shippingValue, shipping_source: shippingValue != null ? shippingSource : null,
          total_cost: totalCost, cost_per_knife: totalCost, short_description: description,
          attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString(),
        }).eq("ebay_item_id", row.ebay_item_id);
        if (saveError) throw new Error(saveError.message);
        if (qualifies) qualifiedIds.push(row.ebay_item_id);
        processed++;
        return;
      }
      // textDecision.kind === "vision": still needs a photo (case ambiguous, handle material
      // ambiguous, or — Sheffield only — blade material unconfirmed), even with the now-enriched
      // description in hand.
      if (visionExhaustedMessage) {
        await supabaseAdmin.from("finder_items").update({ next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), reason: visionExhaustedMessage, short_description: description }).eq("ebay_item_id", row.ebay_item_id);
        deferred++;
        return;
      }
      const vision = await analyzeCarvingSetWithGemini({ title: row.title, description, imageUrl: row.image_url || "", group });
      // textDecision.kind === "vision" here (every other kind returned above), so caseConfirmed/
      // handleConfirmed are always present — pass through what text already established rather than
      // letting a less-reliable vision photo read override an already-settled fact.
      const decision = evaluateCarvingSetVision(group, vision, config().confidence, { hasCase: textDecision.caseConfirmed, handleMaterial: textDecision.handleConfirmed });
      let shippingValue = row.shipping_cost == null ? null : Number(row.shipping_cost);
      let shippingSource = row.shipping_source;
      let shippingReason: string | null = null;
      if (!decision.reason && shippingValue == null) {
        if (Number(row.item_price) > decision.ceiling!) {
          shippingReason = "over_budget";
        } else {
          const shipping = await getItemShippingCost(row.ebay_item_id, await tokenForLookup());
          if (shipping.value != null && (shipping.currency === "" || shipping.currency === "USD")) { shippingValue = shipping.value; shippingSource = "lookup"; }
          else shippingReason = "missing_shipping";
        }
      }
      const totalCost = !decision.reason && shippingValue != null ? Math.round((Number(row.item_price) + shippingValue) * 100) / 100 : null;
      const qualifies = Boolean(!decision.reason && totalCost != null && totalCost <= decision.ceiling!);
      const reason = decision.reason || shippingReason || (qualifies ? null : "over_budget");
      const { error: saveError } = await supabaseAdmin.from("finder_items").update({
        status: qualifies ? "qualified" : "rejected", reason,
        knife_count: 1, contains_folding_knife: false, confidence: vision.confidence, detection_source: "vision", item_category: "carving_set",
        // Material was already resolved from text at discovery (accepted, since only a rejection
        // there would keep it from ever reaching vision) — carried forward as-is, unless this same
        // vision call just confidently overturned it to stainless, in which case the persisted
        // value must reflect that so a later rescan's stale-reuse path (refreshedCarvingSetRow)
        // keeps rejecting it instead of silently re-qualifying a confirmed-stainless set.
        // carving_handle_material, unlike material, is a positive requirement for every group — this
        // vision call always answers it directly ("stag"/"ivory" only when confidently confirmed,
        // "other" otherwise), never merely carried forward, since a fresh answer is available on
        // every vision call. carving_has_case and carving_handle_material use
        // decision.hasCase/decision.handleMaterial (merged with whatever text already confirmed —
        // see evaluateCarvingSetVision), not the raw vision.* fields, so a text-confirmed fact
        // persists correctly even when vision's own photo read disagreed.
        carving_piece_count: vision.pieceCount || null, carving_has_case: decision.hasCase, carving_carbon_steel: decision.reason === "stainless_steel_vision" ? false : row.carving_carbon_steel, carving_handle_material: decision.handleMaterial,
        shipping_cost: shippingValue, shipping_source: shippingValue != null ? shippingSource : null,
        total_cost: totalCost, cost_per_knife: totalCost, short_description: description,
        attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString(),
      }).eq("ebay_item_id", row.ebay_item_id);
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
  // Gaucho-knife rows never have a text-resolved knife_count the way pocket-knife/carving-set
  // rows sometimes do (see lib/gaucho-knife-finder.ts's module comment — a match is inherently
  // visual) — every row reaching this function genuinely needs a vision call, unless the fuller
  // description fetched here newly matches a negative keyword the shorter search-result snippet
  // didn't contain.
  async function processGauchoKnifeRow(row: FinderRow) {
    if (row.run_id) runIds.add(row.run_id);
    // Nothing to compare a candidate against yet — defer without spending an eBay/Gemini call or
    // counting against the row's attempts (so it never hits the 3-attempt "error" cutoff over
    // this alone); it'll pick back up on its own once staff upload a reference photo.
    if (!gauchoReferenceImages.length) {
      await supabaseAdmin.from("finder_items").update({ next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), reason: "No reference images are configured for the gaucho-knife finder yet." }).eq("ebay_item_id", row.ebay_item_id);
      deferred++;
      return;
    }
    try {
      const description = await getItemDescription(row.ebay_item_id, await tokenForLookup());
      const negativeMatch = matchesNegativeKeyword(row.title, description, gauchoNegativePhrases);
      if (negativeMatch) {
        const { error: saveError } = await supabaseAdmin.from("finder_items").update({ status: "rejected", reason: "negative_keyword_match", gaucho_match_notes: `Matched negative keyword: "${negativeMatch}"`, short_description: description, attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString() }).eq("ebay_item_id", row.ebay_item_id);
        if (saveError) throw new Error(saveError.message);
        processed++;
        return;
      }
      if (visionExhaustedMessage) {
        await supabaseAdmin.from("finder_items").update({ next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), reason: visionExhaustedMessage, short_description: description }).eq("ebay_item_id", row.ebay_item_id);
        deferred++;
        return;
      }
      const vision = await analyzeGauchoKnifeMatch({ title: row.title, description, candidateImageUrl: row.image_url || "", referenceImages: gauchoReferenceImages });
      const matchedReferenceId = vision.matchedReferenceIndex != null ? gauchoReferenceImages[vision.matchedReferenceIndex - 1]?.id ?? null : null;
      const qualifies = vision.matches;
      const reason = qualifies ? null : (vision.notes || "no_match");
      let shippingValue = row.shipping_cost == null ? null : Number(row.shipping_cost);
      let shippingSource = row.shipping_source;
      if (shippingValue == null) {
        const shipping = await getItemShippingCost(row.ebay_item_id, await tokenForLookup());
        if (shipping.value != null && (shipping.currency === "" || shipping.currency === "USD")) { shippingValue = shipping.value; shippingSource = "lookup"; }
      }
      const totalCost = shippingValue != null ? Math.round((Number(row.item_price) + shippingValue) * 100) / 100 : null;
      const { error: saveError } = await supabaseAdmin.from("finder_items").update({
        status: qualifies ? "qualified" : "rejected", reason,
        knife_count: 1, contains_folding_knife: false, confidence: vision.confidence, detection_source: "vision", item_category: "gaucho_knife",
        gaucho_match_confidence: vision.confidence, gaucho_maker_match: vision.makerMatch, gaucho_matched_reference_id: matchedReferenceId, gaucho_match_notes: vision.notes,
        shipping_cost: shippingValue, shipping_source: shippingValue != null ? shippingSource : null,
        total_cost: totalCost, cost_per_knife: totalCost, short_description: description,
        attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString(),
      }).eq("ebay_item_id", row.ebay_item_id);
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
  async function processRow(row: FinderRow) {
    const carvingGroup = carvingSetGroupForPhrases(row.keyword_phrases || []);
    if (carvingGroup) return processCarvingSetRow(row, carvingGroup);
    if (gauchoKnifeGroupForPhrases(row.keyword_phrases || [])) return processGauchoKnifeRow(row);
    if (row.run_id) runIds.add(row.run_id);
    const maxCost = resolveMaxCostPerKnife(row.keyword_phrases || [], keywordMaxCost, pocketKnifeSettings.maxCostPerKnife);
    try {
      if (row.knife_count != null) {
        // The text parser already resolved the count (and category, if any) on discovery; this
        // row is only pending because the search result was missing a shipping cost, and
        // initialRow already confirmed the price alone leaves room to qualify — no need to touch
        // Gemini at all.
        const effectiveMax = effectiveMaxCostPerKnife(row.item_category, maxCost, config().swissArmyMaxCost);
        const shipping = await getItemShippingCost(row.ebay_item_id, await tokenForLookup());
        const shippingValue = shipping.value != null && (shipping.currency === "" || shipping.currency === "USD") ? shipping.value : null;
        const deal = shippingValue != null ? calculateDeal(Number(row.item_price), shippingValue, row.knife_count, effectiveMax) : null;
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
      const category = vision.itemCategory;
      const categoryRejected = GARBAGE_CATEGORIES.has(category);
      const effectiveMax = effectiveMaxCostPerKnife(category, maxCost, config().swissArmyMaxCost);
      // A title-stated count (e.g. "lot of 15" on a fixed-blade "skinner"/"hunting knife" listing
      // with no folding/brand wording, so analyzeListingText couldn't resolve it outright) is more
      // reliable than vision's own count from the photo, which is prone to counting a seller's
      // whole catalog/stock shot instead of just this listing's stated lot size. Vision still owns
      // the folding-knife/category classification below — only the numeric count is overridden.
      const textAnalysis = analyzeListingText(row.title, row.short_description);
      const knownCount = textAnalysis.kind === "vision" ? textAnalysis.knownCount : undefined;
      const effectiveKnifeCount = knownCount ?? vision.knifeCount;
      const confident = !categoryRejected && vision.confidence >= config().confidence && effectiveKnifeCount > 0 && effectiveKnifeCount <= FINDER_DEFAULTS.maxPlausibleKnifeCount && vision.containsFoldingKnife;
      let shippingValue = row.shipping_cost == null ? null : Number(row.shipping_cost);
      let shippingSource = row.shipping_source;
      let shippingReason: string | null = null;
      if (confident && shippingValue == null) {
        if (!isShippingLookupWorthwhile(Number(row.item_price), effectiveKnifeCount, effectiveMax)) {
          shippingReason = "over_budget";
        } else {
          const shipping = await getItemShippingCost(row.ebay_item_id, await tokenForLookup());
          if (shipping.value != null && (shipping.currency === "" || shipping.currency === "USD")) { shippingValue = shipping.value; shippingSource = "lookup"; }
          else shippingReason = "missing_shipping";
        }
      }
      const deal = confident && shippingValue != null ? calculateDeal(Number(row.item_price), shippingValue, effectiveKnifeCount, effectiveMax) : null;
      const qualifies = Boolean(confident && deal?.qualifies);
      const reason = categoryRejected ? category : !vision.containsFoldingKnife ? "no_folding_knife" : vision.confidence < config().confidence ? (vision.uncertaintyReason || "low_confidence") : effectiveKnifeCount < 1 ? "invalid_count" : effectiveKnifeCount > FINDER_DEFAULTS.maxPlausibleKnifeCount ? "implausible_count" : shippingReason ? shippingReason : deal?.reason;
      const { error: saveError } = await supabaseAdmin.from("finder_items").update({ status: qualifies ? "qualified" : "rejected", reason, knife_count: effectiveKnifeCount || null, contains_folding_knife: vision.containsFoldingKnife, confidence: vision.confidence, detection_source: "vision", item_category: category, shipping_cost: shippingValue, shipping_source: shippingValue != null ? shippingSource : null, total_cost: deal && "totalCost" in deal ? deal.totalCost : null, cost_per_knife: deal && "costPerKnife" in deal ? deal.costPerKnife : null, attempts: row.attempts + 1, next_attempt_at: null, processed_at: new Date().toISOString() }).eq("ebay_item_id", row.ebay_item_id);
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
  // Runs every minute regardless of either finder's schedule, so an orphaned run gets flipped to
  // "failed" (and the dashboard stops showing it as active) within a minute of going stale, rather
  // than waiting for the next automatic scan or a staff member clicking "Run now".
  await reconcileOrphanedRuns();
  const [pocketSchedule, carvingSchedule, gauchoSchedule] = await Promise.all([
    getScheduleSettings("pocket_knife"),
    getScheduleSettings("carving_set"),
    getScheduleSettings("gaucho_knife"),
  ]);
  const runs: Partial<Record<FinderCategory, Awaited<ReturnType<typeof startFinderRun>>>> = {};
  // Each finder's automatic scan is independently scheduled and genuinely category-scoped now
  // (unlike the old single unscoped daily call) — one finder firing never touches another's
  // keywords, matching the manual "Run now" buttons' behavior.
  if (isScheduledRunTime(pocketSchedule, date)) runs.pocket_knife = await startFinderRun("scheduled", `scheduled:pocket_knife:${easternDateKey(date)}`, "pocket_knife");
  if (isScheduledRunTime(carvingSchedule, date)) runs.carving_set = await startFinderRun("scheduled", `scheduled:carving_set:${easternDateKey(date)}`, "carving_set");
  if (isScheduledRunTime(gauchoSchedule, date)) runs.gaucho_knife = await startFinderRun("scheduled", `scheduled:gaucho_knife:${easternDateKey(date)}`, "gaucho_knife");
  const queue = await processPendingFinderItems();
  return { runs, queue };
}

export async function finderOverview(category?: FinderCategory) {
  const [allKeywords, results, runs, pending, rejected, qualified, usage, dailyUsage, notifySettingsRow, notifyRecipientRows, schedule] = await Promise.all([
    supabaseAdmin.from("finder_keywords").select("*").order("created_at"),
    scopeToCategory(supabaseAdmin.from("finder_items").select("*").eq("status", "qualified").is("dismissed_at", null).order("discovered_at", { ascending: false }).limit(500), category),
    category ? supabaseAdmin.from("finder_runs").select("*").or(`category.is.null,category.eq.${category}`).order("started_at", { ascending: false }).limit(10) : supabaseAdmin.from("finder_runs").select("*").order("started_at", { ascending: false }).limit(10),
    scopeToCategory(supabaseAdmin.from("finder_items").select("ebay_item_id", { count: "exact", head: true }).eq("status", "pending"), category),
    scopeToCategory(supabaseAdmin.from("finder_items").select("ebay_item_id", { count: "exact", head: true }).in("status", ["rejected", "error"]), category),
    scopeToCategory(supabaseAdmin.from("finder_items").select("ebay_item_id", { count: "exact", head: true }).eq("status", "qualified").is("dismissed_at", null), category),
    supabaseAdmin.from("finder_vision_usage").select("*").eq("month", monthKey()).maybeSingle(),
    supabaseAdmin.from("finder_vision_usage_daily").select("*").eq("day", dayKey()).maybeSingle(),
    supabaseAdmin.from("finder_notify_settings").select("notify_mode, last_attempt_at, last_error, last_success_at").eq("id", true).maybeSingle(),
    supabaseAdmin.from("finder_notify_recipients").select("*").order("created_at"),
    category ? getScheduleSettings(category) : Promise.resolve(null),
  ]);
  const firstError = [allKeywords.error, results.error, runs.error, pending.error, rejected.error, qualified.error, usage.error, dailyUsage.error, notifySettingsRow.error, notifyRecipientRows.error].find(Boolean);
  if (firstError) throw new Error(firstError.message);
  // No category column on finder_keywords — filter in JS with the same phrase test the run-scan
  // and per-item dispatch both use (see keywordCategory above), so each settings page only ever
  // sees its own keyword rows.
  const keywords = category
    ? (allKeywords.data || []).filter((keyword) => keywordCategory(keyword.phrase) === category)
    : (allKeywords.data || []);
  // Gaucho-knife-only settings: its negative-keyword filter and staff-uploaded reference images,
  // neither of which the other two categories' settings pages have any use for.
  const [negativeKeywords, referenceImages] = category === "gaucho_knife"
    ? await Promise.all([
        supabaseAdmin.from("finder_gaucho_negative_keywords").select("*").order("created_at"),
        supabaseAdmin.from("finder_reference_images").select("*").eq("category", "gaucho_knife").order("created_at"),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (negativeKeywords.error) throw new Error(negativeKeywords.error.message);
  if (referenceImages.error) throw new Error(referenceImages.error.message);
  const referenceImagesWithUrls = await Promise.all((referenceImages.data || []).map(async (row) => {
    const signed = await supabaseAdmin.storage.from("finder-reference-images").createSignedUrl(row.storage_path, 60 * 60);
    return { ...row, signedUrl: signed.data?.signedUrl || null };
  }));
  const free = Number(usage.data?.free_analyses || 0);
  const paid = Number(usage.data?.paid_analyses || 0);
  const analyses = free + paid;
  const { monthlyLimit, dailyLimit } = config();
  const dailyAnalyses = Number(dailyUsage.data?.analyses || 0);
  const notifyRecipients = notifyRecipientRows.data || [];
  const pocketKnifeSettings = await getPocketKnifeSettings();
  return {
    keywords, results: results.data || [], runs: runs.data || [],
    negativeKeywords: negativeKeywords.data || [], referenceImages: referenceImagesWithUrls,
    counts: { pending: pending.count || 0, rejected: rejected.count || 0, qualified: qualified.count || 0 },
    notify: {
      mode: notifySettingsRow.data?.notify_mode === "all_qualified" ? "all_qualified" : "auctions_only",
      recipients: notifyRecipients,
      usingEnvFallback: !notifyRecipients.length,
      lastAttemptAt: notifySettingsRow.data?.last_attempt_at ?? null,
      lastError: notifySettingsRow.data?.last_error ?? null,
      lastSuccessAt: notifySettingsRow.data?.last_success_at ?? null,
    },
    schedule,
    // The monthly cap (reserve_finder_vision_usage) counts free + paid analyses together and
    // applies regardless of mode, so the budget the UI shows must match that, not just the
    // paid-mode count — free-mode analyses aren't actually free once Google's own free-tier
    // quota runs out; they just aren't tracked separately as spend by this app. The daily figures
    // reflect the separate pacing cap that spreads the monthly budget evenly across the month
    // instead of letting a busy week exhaust it up front.
    budget: {
      mode: process.env.GEMINI_PAID_MODE === "true" ? "paid" : "free",
      freeAnalyses: free, paidAnalyses: paid, analyses, monthlyLimit, remaining: Math.max(0, monthlyLimit - analyses), projectedMaximum: analyses * 0.001,
      dailyAnalyses, dailyLimit, dailyRemaining: Math.max(0, dailyLimit - dailyAnalyses),
    },
    settings: { zip: process.env.EBAY_FINDER_ZIP || FINDER_DEFAULTS.zip, maxCostPerKnife: pocketKnifeSettings.maxCostPerKnife },
  };
}

export async function archivedFinderItems(category?: FinderCategory) {
  const { data, error } = await scopeToCategory(supabaseAdmin.from("finder_items").select("*").eq("status", "qualified").not("dismissed_at", "is", null).order("dismissed_at", { ascending: false }).limit(500), category);
  if (error) throw new Error(error.message);
  return { results: data || [] };
}

// Every rejected row already carries a `reason` (see initialRow/refreshedRow, initialCarvingSetRow,
// and the vision-processing paths above) — this just gives staff somewhere to see it, so a listing
// found manually on eBay that the finder passed over can be checked against the actual reason
// instead of staying an unexplained mismatch.
export async function rejectedFinderItems(category?: FinderCategory) {
  const { data, error } = await scopeToCategory(supabaseAdmin.from("finder_items").select("*").eq("status", "rejected").order("processed_at", { ascending: false }).limit(200), category);
  if (error) throw new Error(error.message);
  return { results: data || [] };
}
