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

function paidMode() { return process.env.GEMINI_PAID_MODE === "true"; }
function monthlyLimit() { return Number(process.env.GEMINI_MONTHLY_ANALYSIS_LIMIT || FINDER_DEFAULTS.monthlyAnalysisLimit); }

async function reserveUsage() {
  const month = monthKey();
  const { data, error } = await supabaseAdmin.rpc("reserve_finder_vision_usage", { p_month: month, p_paid_mode: paidMode(), p_monthly_limit: monthlyLimit() }).single();
  if (error) throw new Error(error.message);
  if (!data?.reserved) throw new VisionBudgetError("Monthly Gemini analysis limit reached.");
}

function compactEbayImage(url: string) { return url.replace(/s-l\d+/i, "s-l640"); }

async function imagePart(url: string) {
  const response = await fetch(compactEbayImage(url));
  if (!response.ok) throw new Error(`Could not download listing image (${response.status}).`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error("Listing image has an unsupported content type.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 5_000_000) throw new Error("Listing image is too large to analyze.");
  return { inlineData: { mimeType: contentType, data: Buffer.from(bytes).toString("base64") } };
}

export async function countKnivesWithGemini(input: { title: string; description: string; imageUrl: string }): Promise<VisionCount> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  await reserveUsage();
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const prompt = `Analyze this eBay listing for a folding pocket-knife buyer. Count every physical knife included in one purchase, including fixed-blade or kitchen knives in a mixed lot, but do not count cases, tools, or repeated views of the same knife. Confirm whether at least one included knife is a folding pocket knife. If this is a choose-one/selection listing, the image is unclear, items overlap too much, or the exact included count cannot be established, lower confidence and explain why. Title: ${input.title.slice(0, 300)}. Description: ${input.description.slice(0, 1200)}.`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, await imagePart(input.imageUrl)] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 180,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: ["knifeCount", "containsFoldingKnife", "confidence", "uncertaintyReason"],
          properties: {
            knifeCount: { type: "INTEGER", minimum: 0 },
            containsFoldingKnife: { type: "BOOLEAN" },
            confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
            uncertaintyReason: { type: "STRING" },
          },
        },
      },
    }),
  });
  if (response.status === 429) throw new VisionQuotaError("Gemini free quota is temporarily exhausted.");
  if (!response.ok) {
    // Google's error body (e.g. "Generative Language API has not been used in project ... before
    // or it is disabled", "API key not valid", permission/model-access errors) is far more useful
    // for diagnosing a broken key/project than the bare status code, and previously wasn't
    // captured anywhere — it only ever showed up as "Gemini analysis failed (403)." with no way
    // to tell which of several possible causes was the actual one.
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini analysis failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}.`);
  }
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text || "";
  const parsed = JSON.parse(text) as Partial<VisionCount>;
  if (!Number.isInteger(parsed.knifeCount) || typeof parsed.containsFoldingKnife !== "boolean" || typeof parsed.confidence !== "number" || typeof parsed.uncertaintyReason !== "string") throw new Error("Gemini returned an invalid knife count.");
  return parsed as VisionCount;
}
