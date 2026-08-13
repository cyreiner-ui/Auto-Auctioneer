// One-off benchmark: re-runs Moondream against listings Gemini already resolved, so the
// switch can be judged against real historical results instead of a guess. Not part of
// `npm test` — it hits the live Moondream API and reads production Supabase data. Run with:
//
//   node --experimental-strip-types --import ./tests/helpers/register-ts-resolve.mjs \
//     scripts/compare-vision-providers.mjs [limit]
//
// Requires MOONDREAM_API_KEY (and the usual SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) to be set
// in the environment. Each row processed here also reserves against the app's own monthly
// Moondream usage counter (finder_vision_usage), exactly like a real finder tick would.

import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { countKnivesWithMoondream } from "../lib/moondream-vision.ts";

const LIMIT = Number(process.argv[2]) || 30;
// Moondream's free tier allows 2 requests/second; running sequentially with a small gap keeps
// this benchmark itself from tripping that limit and skewing the results with avoidable 429s.
const DELAY_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function main() {
  if (!process.env.MOONDREAM_API_KEY?.trim()) {
    console.error("MOONDREAM_API_KEY is not set — export it before running this script.");
    process.exit(1);
  }

  const { data: rows, error } = await supabaseAdmin
    .from("finder_items")
    .select("ebay_item_id, ebay_url, title, short_description, image_url, knife_count, contains_folding_knife, confidence")
    .eq("detection_source", "vision")
    .not("image_url", "is", null)
    .order("processed_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw new Error(error.message);
  if (!rows?.length) {
    console.log("No finder_items rows with detection_source = 'vision' were found — nothing to compare yet.");
    return;
  }

  const results = [];
  for (const row of rows) {
    const startedAt = Date.now();
    try {
      const fresh = await countKnivesWithMoondream({ title: row.title, description: row.short_description, imageUrl: row.image_url });
      results.push({ row, fresh, latencyMs: Date.now() - startedAt, error: null });
    } catch (err) {
      results.push({ row, fresh: null, latencyMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(DELAY_MS);
  }

  const ok = results.filter((r) => r.fresh);
  const knifeCountMatches = ok.filter((r) => r.fresh.knifeCount === r.row.knife_count);
  const foldingMatches = ok.filter((r) => r.fresh.containsFoldingKnife === r.row.contains_folding_knife);
  const latencies = ok.map((r) => r.latencyMs);

  console.log(`\n${"ebay_item_id".padEnd(14)} ${"title".padEnd(40)} gemini(count/fold/conf)   moondream(count/fold/conf)   match   ms`);
  for (const { row, fresh, latencyMs, error: err } of results) {
    const title = (row.title || "").slice(0, 38).padEnd(40);
    const geminiSummary = `${row.knife_count}/${row.contains_folding_knife}/${row.confidence}`.padEnd(24);
    if (err) {
      console.log(`${row.ebay_item_id.padEnd(14)} ${title} ${geminiSummary} ERROR: ${err}`);
      continue;
    }
    const moondreamSummary = `${fresh.knifeCount}/${fresh.containsFoldingKnife}/${fresh.confidence}`.padEnd(28);
    const countMatch = fresh.knifeCount === row.knife_count;
    const foldMatch = fresh.containsFoldingKnife === row.contains_folding_knife;
    const match = countMatch && foldMatch ? "yes" : "NO";
    console.log(`${row.ebay_item_id.padEnd(14)} ${title} ${geminiSummary} ${moondreamSummary} ${match.padEnd(6)} ${latencyMs}`);
    if (!countMatch || !foldMatch) console.log(`  -> disagreement, check the photo: ${row.ebay_url}`);
  }

  console.log("\n--- summary ---");
  console.log(`rows compared: ${results.length} (${ok.length} succeeded, ${results.length - ok.length} errored)`);
  if (ok.length) {
    console.log(`knifeCount agreement: ${knifeCountMatches.length}/${ok.length} (${Math.round((knifeCountMatches.length / ok.length) * 100)}%)`);
    console.log(`containsFoldingKnife agreement: ${foldingMatches.length}/${ok.length} (${Math.round((foldingMatches.length / ok.length) * 100)}%)`);
    console.log(`latency ms — min: ${Math.min(...latencies)}, median: ${median(latencies)}, max: ${Math.max(...latencies)}`);
  }
  console.log("Agreement with Gemini is not ground truth by itself — Gemini could have been wrong too. Pull up the flagged listing URLs above and judge the disagreements by eye.");
}

main().catch((err) => { console.error(err); process.exit(1); });
