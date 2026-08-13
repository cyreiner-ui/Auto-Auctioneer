import { FINDER_DEFAULTS, monthKey } from "./finder-core";
import { supabaseAdmin } from "./supabase-admin";

export class VisionQuotaError extends Error {}
export class VisionBudgetError extends Error {}

export type VisionCount = {
  knifeCount: number;
  containsFoldingKnife: boolean;
  confidence: number;
  uncertaintyReason: string;
};

function paidMode() { return process.env.MOONDREAM_PAID_MODE === "true"; }
function monthlyLimit() { return Number(process.env.MOONDREAM_MONTHLY_ANALYSIS_LIMIT || FINDER_DEFAULTS.monthlyPaidAnalysisLimit); }

async function reserveUsage() {
  const month = monthKey();
  const { data, error } = await supabaseAdmin.rpc("reserve_finder_vision_usage", { p_month: month, p_paid_mode: paidMode(), p_monthly_limit: monthlyLimit() }).single();
  if (error) throw new Error(error.message);
  if (!data?.reserved) throw new VisionBudgetError("Monthly Moondream analysis limit reached.");
}

function compactEbayImage(url: string) { return url.replace(/s-l\d+/i, "s-l640"); }

async function imageDataUri(url: string) {
  const response = await fetch(compactEbayImage(url));
  if (!response.ok) throw new Error(`Could not download listing image (${response.status}).`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error("Listing image has an unsupported content type.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 5_000_000) throw new Error("Listing image is too large to analyze.");
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function moondreamRequest(path: string, key: string, body: unknown) {
  const response = await fetch(`https://api.moondream.ai${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Moondream-Auth": key },
    body: JSON.stringify(body),
  });
  if (response.status === 429) throw new VisionQuotaError("Moondream free-tier rate limit is temporarily exhausted.");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Moondream analysis failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ""}.`);
  }
  return response.json();
}

// Free-text VQA counting (asking the model "how many knives?" in a prompt) turned out
// unreliable on cluttered/mixed lots — a benchmark against Gemini's historical results (see
// scripts/compare-vision-providers.mjs) found it undercounting or overcounting by a wide
// margin on exactly those listings. /v1/detect instead returns a real bounding box per
// detected instance, so the count is "how many boxes came back" rather than the model's
// free-text guess — Moondream's actual grounded-counting mechanism, not a VQA workaround.
async function detectCount(imageDataUrl: string, key: string, model: string, object: string): Promise<number> {
  const payload = await moondreamRequest("/v1/detect", key, { model, image_url: imageDataUrl, object }) as { objects?: unknown };
  if (!Array.isArray(payload.objects)) throw new Error("Moondream returned an invalid knife count.");
  return payload.objects.length;
}

type Judgment = { containsFoldingKnife: boolean; confidence: number; uncertaintyReason: string };

async function judge(imageDataUrl: string, key: string, model: string, title: string, description: string): Promise<Judgment> {
  const question = `Analyze this eBay listing for a folding pocket-knife buyer. Confirm whether at least one included knife is a folding pocket knife, as opposed to only fixed-blade/kitchen knives or knife-shaped tools. If this is a choose-one/selection listing (the buyer picks one item out of several shown), the image is unclear, items overlap too much to tell what's included, or you cannot confidently make this determination, lower confidence and explain why. Title: ${title.slice(0, 300)}. Description: ${description.slice(0, 1200)}. Respond with ONLY a single JSON object and no other text: {"containsFoldingKnife": <boolean>, "confidence": <number 0-1>, "uncertaintyReason": <string>}.`;
  const payload = await moondreamRequest("/v1/query", key, { model, image_url: imageDataUrl, question }) as { answer?: string };
  const match = (payload.answer || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Moondream returned an invalid knife count.");
  let parsed: Partial<Judgment>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("Moondream returned an invalid knife count.");
  }
  if (typeof parsed.containsFoldingKnife !== "boolean" || typeof parsed.confidence !== "number" || typeof parsed.uncertaintyReason !== "string") throw new Error("Moondream returned an invalid knife count.");
  return parsed as Judgment;
}

export async function countKnivesWithMoondream(input: { title: string; description: string; imageUrl: string }): Promise<VisionCount> {
  const key = process.env.MOONDREAM_API_KEY?.trim();
  if (!key) throw new Error("MOONDREAM_API_KEY is not configured.");
  await reserveUsage();
  const model = process.env.MOONDREAM_MODEL || "moondream3.1-9B-A2B";
  const imageDataUrl = await imageDataUri(input.imageUrl);
  // Sequential, not parallel: Moondream's free tier caps at 2 requests/second, and this
  // function already makes two calls per item — staying sequential keeps a single item's
  // own calls from doubling up against that limit.
  const knifeCount = await detectCount(imageDataUrl, key, model, "knife");
  const judgment = await judge(imageDataUrl, key, model, input.title, input.description);
  return { knifeCount, ...judgment };
}
