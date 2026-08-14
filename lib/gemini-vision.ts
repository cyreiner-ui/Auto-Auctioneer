import { dayKey, FINDER_DEFAULTS, monthKey } from "./finder-core";
import { supabaseAdmin } from "./supabase-admin";

export class VisionQuotaError extends Error {}
export class VisionBudgetError extends Error {}

export type ItemCategory =
  | "pocket_knife"
  | "swiss_army_multi_tool"
  | "multi_tool"
  | "plain_blade"
  | "credit_card_knife"
  | "coin_knife"
  | "box_cutter"
  | "throwing_knife"
  | "keychain_knife"
  | "other";

export type VisionCount = {
  knifeCount: number;
  containsFoldingKnife: boolean;
  confidence: number;
  uncertaintyReason: string;
  itemCategory: ItemCategory;
};

const ITEM_CATEGORIES: ItemCategory[] = [
  "pocket_knife",
  "swiss_army_multi_tool",
  "multi_tool",
  "plain_blade",
  "credit_card_knife",
  "coin_knife",
  "box_cutter",
  "throwing_knife",
  "keychain_knife",
  "other",
];

function paidMode() { return process.env.GEMINI_PAID_MODE === "true"; }
function monthlyLimit() { return Number(process.env.GEMINI_MONTHLY_ANALYSIS_LIMIT || FINDER_DEFAULTS.monthlyAnalysisLimit); }
// Defaults to spreading the monthly cap evenly across a 30-day month, so a single busy week can't
// exhaust the whole month's budget and leave the rest of it with no vision analysis at all.
// Override directly with GEMINI_DAILY_ANALYSIS_LIMIT for a different pace.
function dailyLimit() { return Number(process.env.GEMINI_DAILY_ANALYSIS_LIMIT || Math.ceil(monthlyLimit() / 30)); }

// Exported so lib/carving-set-finder.ts's separate vision algorithm can share the same budget
// pool and image-fetch plumbing without sharing any pocket-knife-specific decision logic.
export async function reserveUsage() {
  const { data, error } = await supabaseAdmin.rpc("reserve_finder_vision_usage", {
    p_month: monthKey(), p_day: dayKey(), p_paid_mode: paidMode(), p_monthly_limit: monthlyLimit(), p_daily_limit: dailyLimit(),
  }).single();
  if (error) throw new Error(error.message);
  if (!data?.reserved) {
    throw new VisionBudgetError(data?.limit_reason === "daily" ? "Daily Gemini analysis pacing cap reached; resumes tomorrow." : "Monthly Gemini analysis limit reached.");
  }
}

function compactEbayImage(url: string) { return url.replace(/s-l\d+/i, "s-l640"); }

export async function imagePart(url: string) {
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
  const prompt = `Analyze this eBay listing for a folding pocket-knife buyer. Count every physical knife included in one purchase, including fixed-blade or kitchen knives in a mixed lot, but do not count cases, tools, or repeated views of the same knife. Confirm whether at least one included knife is a folding pocket knife. If this is a choose-one/selection listing, the image is unclear, items overlap too much, or the exact included count cannot be established, lower confidence and explain why. Then classify the primary item into exactly one category: pocket_knife (a normal folding or fixed-blade knife with a handle), swiss_army_multi_tool (a Victorinox/Wenger-style Swiss Army multi-tool with a small blade plus other tools), multi_tool (any other combo-tool, e.g. a Leatherman-style pliers tool, or a blade combined with a corkscrew or bottle opener, that is not Swiss-Army-style), plain_blade (a bare blade with no handle), credit_card_knife (a thin credit-card- or wallet-shaped folding knife), coin_knife (a coin- or medallion-shaped folding knife), box_cutter (a utility/box-cutter/razor knife), throwing_knife (a knife designed/balanced for throwing, often sold in matching sets, not for folding/pocket carry), keychain_knife (a miniature knife attached to or designed as a keychain/keyring fob), or other. Title: ${input.title.slice(0, 300)}. Description: ${input.description.slice(0, 1200)}.`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, await imagePart(input.imageUrl)] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 250,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: ["knifeCount", "containsFoldingKnife", "confidence", "uncertaintyReason", "itemCategory"],
          properties: {
            knifeCount: { type: "INTEGER", minimum: 0 },
            containsFoldingKnife: { type: "BOOLEAN" },
            confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
            uncertaintyReason: { type: "STRING" },
            itemCategory: { type: "STRING", enum: ITEM_CATEGORIES },
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
  if (
    !Number.isInteger(parsed.knifeCount) ||
    typeof parsed.containsFoldingKnife !== "boolean" ||
    typeof parsed.confidence !== "number" ||
    typeof parsed.uncertaintyReason !== "string" ||
    typeof parsed.itemCategory !== "string" ||
    !ITEM_CATEGORIES.includes(parsed.itemCategory as ItemCategory)
  ) throw new Error("Gemini returned an invalid knife count.");
  return parsed as VisionCount;
}
