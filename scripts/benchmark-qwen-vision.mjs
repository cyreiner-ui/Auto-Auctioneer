// One-off research benchmark: tests Qwen2.5-VL (via OpenRouter's free tier) as a second
// candidate to replace Gemini, after Moondream (see scripts/compare-vision-providers.mjs and
// PR #30) proved unreliable specifically on large/cluttered bulk-lot listings. This script
// does NOT touch lib/moondream-vision.ts, lib/finder-service.ts, or any production code — it
// only reads historical Supabase data and calls OpenRouter directly, to decide whether Qwen
// is worth building in for real. Run with:
//
//   node --experimental-strip-types --import ./tests/helpers/register-ts-resolve.mjs \
//     scripts/benchmark-qwen-vision.mjs [limit]
//
// Requires OPENROUTER_API_KEY (free signup at openrouter.ai) and the same
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY used by scripts/compare-vision-providers.mjs.
//
// OpenRouter's free tier (":free"-suffixed models) caps at 20 requests/minute and 50/day
// unless $10+ in credits has ever been added to the account (which raises the daily cap to
// 1000, still free to use) — if the daily cap is hit mid-run, re-run the rest another day.

import { supabaseAdmin } from "../lib/supabase-admin.ts";

const LIMIT = Number(process.argv[2]) || 30;
// Qwen2.5-VL's free-tier slug was pulled from OpenRouter's roster (it rotates over time) —
// this is the only currently-free model on OpenRouter explicitly branded as vision-language.
const MODEL = "nvidia/nemotron-nano-12b-v2-vl:free";
// Stay comfortably under the 20 requests/minute free-tier cap (one request per ~3.5s is ~17/min).
const DELAY_MS = 3500;

// Manually verified against the actual eBay photos earlier this session — the real ground
// truth, not just "what Gemini said". Used to call out these three rows specifically.
const GROUND_TRUTH = {
  "v1|116875794611|0": 65,
  "v1|178358487298|0": 27,
  "v1|178400845227|0": 1,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function buildPrompt(title, description) {
  return `Analyze this eBay listing for a folding pocket-knife buyer. Count every physical knife included in one purchase, including fixed-blade or kitchen knives in a mixed lot, but do not count cases, tools, or repeated views of the same knife. Confirm whether at least one included knife is a folding pocket knife. If this is a choose-one/selection listing, the image is unclear, items overlap too much, or the exact included count cannot be established, lower confidence and explain why. Title: ${title.slice(0, 300)}. Description: ${description.slice(0, 1200)}. Respond with ONLY a single JSON object and no other text: {"knifeCount": <integer>, "containsFoldingKnife": <boolean>, "confidence": <number 0-1>, "uncertaintyReason": <string>}.`;
}

function extractJson(text) {
  const match = (text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Qwen returned an invalid knife count.");
  return JSON.parse(match[0]);
}

async function analyzeWithQwen(key, title, description, imageUrl) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    // Free-tier models can be slow or queued under load; a hard ceiling stops one stuck
    // request from silently stalling the whole run with no visible progress.
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: buildPrompt(title, description) },
        ],
      }],
      response_format: { type: "json_object" },
    }),
  });
  if (response.status === 429) throw new Error("OpenRouter free-tier rate limit hit (429).");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Qwen analysis failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}.`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  const parsed = extractJson(content);
  if (!Number.isInteger(parsed.knifeCount) || typeof parsed.containsFoldingKnife !== "boolean" || typeof parsed.confidence !== "number" || typeof parsed.uncertaintyReason !== "string") {
    throw new Error("Qwen returned an invalid knife count.");
  }
  return parsed;
}

async function main() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    console.error("OPENROUTER_API_KEY is not set — export it before running this script.");
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

  console.log(`\n${"ebay_item_id".padEnd(14)} ${"title".padEnd(40)} gemini(count/fold/conf)   qwen(count/fold/conf)        match   ms`);
  const results = [];
  for (const [index, row] of rows.entries()) {
    const startedAt = Date.now();
    const title = (row.title || "").slice(0, 38).padEnd(40);
    const geminiSummary = `${row.knife_count}/${row.contains_folding_knife}/${row.confidence}`.padEnd(24);
    const groundTruth = GROUND_TRUTH[row.ebay_item_id];
    process.stdout.write(`[${index + 1}/${rows.length}] ${row.ebay_item_id} ... `);
    try {
      const fresh = await analyzeWithQwen(key, row.title, row.short_description, row.image_url);
      const latencyMs = Date.now() - startedAt;
      results.push({ row, fresh, latencyMs, error: null });
      const countMatch = fresh.knifeCount === row.knife_count;
      const foldMatch = fresh.containsFoldingKnife === row.contains_folding_knife;
      const match = countMatch && foldMatch ? "yes" : "NO";
      console.log(`done (${latencyMs}ms)\n${row.ebay_item_id.padEnd(14)} ${title} ${geminiSummary} ${`${fresh.knifeCount}/${fresh.containsFoldingKnife}/${fresh.confidence}`.padEnd(24)} ${match.padEnd(6)} ${latencyMs}`);
      if (groundTruth != null) console.log(`  -> GROUND TRUTH for this listing is ${groundTruth} knives (verified against the actual photo). Qwen said ${fresh.knifeCount}.`);
      else if (!countMatch || !foldMatch) console.log(`  -> disagreement, check the photo: ${row.ebay_url}`);
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      results.push({ row, fresh: null, latencyMs, error: message });
      console.log(`FAILED (${latencyMs}ms)\n${row.ebay_item_id.padEnd(14)} ${title} ${geminiSummary} ERROR: ${message}`);
    }
    await sleep(DELAY_MS);
  }

  const ok = results.filter((r) => r.fresh);
  const knifeCountMatches = ok.filter((r) => r.fresh.knifeCount === r.row.knife_count);
  const foldingMatches = ok.filter((r) => r.fresh.containsFoldingKnife === r.row.contains_folding_knife);
  const latencies = ok.map((r) => r.latencyMs);

  console.log("\n--- summary ---");
  console.log(`rows compared: ${results.length} (${ok.length} succeeded, ${results.length - ok.length} errored)`);
  if (ok.length) {
    console.log(`knifeCount agreement with Gemini: ${knifeCountMatches.length}/${ok.length} (${Math.round((knifeCountMatches.length / ok.length) * 100)}%)`);
    console.log(`containsFoldingKnife agreement with Gemini: ${foldingMatches.length}/${ok.length} (${Math.round((foldingMatches.length / ok.length) * 100)}%)`);
    console.log(`latency ms — min: ${Math.min(...latencies)}, median: ${median(latencies)}, max: ${Math.max(...latencies)}`);
  }
  console.log("Agreement with Gemini is not ground truth by itself. The three GROUND TRUTH rows above are actually verified against real photos — weight those far more heavily than the raw agreement percentage.");
}

main().catch((err) => { console.error(err); process.exit(1); });
