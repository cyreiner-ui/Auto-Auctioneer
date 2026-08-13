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

function extractJson(answer: string) {
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Moondream returned an invalid knife count.");
  try {
    return JSON.parse(match[0]) as Partial<VisionCount>;
  } catch {
    throw new Error("Moondream returned an invalid knife count.");
  }
}

export async function countKnivesWithMoondream(input: { title: string; description: string; imageUrl: string }): Promise<VisionCount> {
  const key = process.env.MOONDREAM_API_KEY?.trim();
  if (!key) throw new Error("MOONDREAM_API_KEY is not configured.");
  await reserveUsage();
  const model = process.env.MOONDREAM_MODEL || "moondream3.1-9B-A2B";
  const question = `Analyze this eBay listing for a folding pocket-knife buyer. Count every physical knife included in one purchase, including fixed-blade or kitchen knives in a mixed lot, but do not count cases, tools, or repeated views of the same knife. Confirm whether at least one included knife is a folding pocket knife. If this is a choose-one/selection listing, the image is unclear, items overlap too much, or the exact included count cannot be established, lower confidence and explain why. Title: ${input.title.slice(0, 300)}. Description: ${input.description.slice(0, 1200)}. Respond with ONLY a single JSON object and no other text: {"knifeCount": <integer>, "containsFoldingKnife": <boolean>, "confidence": <number 0-1>, "uncertaintyReason": <string>}.`;
  const response = await fetch("https://api.moondream.ai/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Moondream-Auth": key },
    body: JSON.stringify({ model, image_url: await imageDataUri(input.imageUrl), question }),
  });
  if (response.status === 429) throw new VisionQuotaError("Moondream free-tier rate limit is temporarily exhausted.");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Moondream analysis failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}.`);
  }
  const payload = await response.json() as { answer?: string };
  const parsed = extractJson(payload.answer || "");
  if (!Number.isInteger(parsed.knifeCount) || typeof parsed.containsFoldingKnife !== "boolean" || typeof parsed.confidence !== "number" || typeof parsed.uncertaintyReason !== "string") throw new Error("Moondream returned an invalid knife count.");
  return parsed as VisionCount;
}
