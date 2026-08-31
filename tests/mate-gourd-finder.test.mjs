import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeMateGourdMatch,
  imageSearchPhrase,
  initialMateGourdRow,
  mateGourdGroupForPhrases,
  matchesNegativeKeyword,
  refreshedMateGourdRow,
} from "../lib/mate-gourd-finder.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

test("mateGourdGroupForPhrases matches a known positive phrase", () => {
  assert.equal(mateGourdGroupForPhrases(["mate gourd"]), true);
  assert.equal(mateGourdGroupForPhrases(["guampa"]), true);
});

test("mateGourdGroupForPhrases matches the synthetic image-search marker", () => {
  assert.equal(mateGourdGroupForPhrases([imageSearchPhrase("some-reference-id")]), true);
});

test("mateGourdGroupForPhrases returns false for an unrelated phrase, including gaucho-knife's own image-search marker", () => {
  assert.equal(mateGourdGroupForPhrases(["pocket knife lot"]), false);
  assert.equal(mateGourdGroupForPhrases(["gaucho knife"]), false);
  // Distinct prefixes are the whole point — a gaucho-knife image-search row must never also read
  // as a mate-gourd row, or vice versa (the cross-finder "mixing" bug this scheme exists to avoid).
  assert.equal(mateGourdGroupForPhrases(["__image_search:some-id"]), false);
});

test("matchesNegativeKeyword is case-insensitive and checks title + description", () => {
  assert.equal(matchesNegativeKeyword("Antique Mate Gourd", "", ["coffee mug"]), null);
  assert.equal(matchesNegativeKeyword("Vintage COFFEE MUG", "", ["coffee mug"]), "coffee mug");
  assert.equal(matchesNegativeKeyword("Gourd", "actually just a coffee mug shaped like one", ["coffee mug"]), "coffee mug");
});

function item(overrides = {}) {
  return {
    itemId: "v1|222|0", title: "Antique Silver Mate Gourd", shortDescription: "", itemWebUrl: "https://ebay.test/itm/222",
    imageUrl: "https://i.ebayimg.com/x.jpg", itemPrice: 40, shippingCost: 8, shippingCurrency: "USD", currency: "USD",
    buyingOptions: ["FIXED_PRICE"], itemEndDate: null,
    ...overrides,
  };
}

test("initialMateGourdRow rejects a negative-keyword match without needing a photo", () => {
  const row = initialMateGourdRow(item({ title: "Ceramic Coffee Mug" }), ["mate gourd"], "run-1", ["ceramic"]);
  assert.equal(row.status, "rejected");
  assert.equal(row.reason, "negative_keyword_match");
});

test("initialMateGourdRow rejects a listing with no photo", () => {
  const row = initialMateGourdRow(item({ imageUrl: null }), ["mate gourd"], "run-1", []);
  assert.equal(row.status, "rejected");
  assert.equal(row.reason, "missing_image");
});

test("initialMateGourdRow otherwise always lands in pending — there is no text-only qualification path", () => {
  const row = initialMateGourdRow(item(), ["mate gourd"], "run-1", []);
  assert.equal(row.status, "pending");
  assert.equal(row.item_category, "mate_gourd");
  assert.equal(row.knife_count, 1);
});

test("initialMateGourdRow computes total_cost for display only, with no gating", () => {
  const row = initialMateGourdRow(item({ itemPrice: 60, shippingCost: 15 }), ["mate gourd"], "run-1", []);
  assert.equal(row.total_cost, 75);
  assert.equal(row.cost_per_knife, 75);
});

test("refreshedMateGourdRow reuses a prior vision verdict instead of re-spending Gemini, when nothing new rejects it", () => {
  const existing = {
    status: "qualified", reason: null, detection_source: "vision", confidence: 0.94,
    mate_gourd_match_confidence: 0.94, mate_gourd_matched_reference_id: "ref-1", mate_gourd_match_notes: "Matches reference 1.",
    shipping_cost: null, shipping_source: null,
  };
  const row = refreshedMateGourdRow(item(), ["mate gourd"], "run-2", existing, []);
  assert.equal(row.status, "qualified");
  assert.equal(row.detection_source, "vision");
  assert.equal(row.mate_gourd_matched_reference_id, "ref-1");
});

test("refreshedMateGourdRow lets a newly-added negative keyword override a stale qualified verdict", () => {
  const existing = {
    status: "qualified", reason: null, detection_source: "vision", confidence: 0.94,
    mate_gourd_match_confidence: 0.94, mate_gourd_matched_reference_id: "ref-1", mate_gourd_match_notes: "Matches reference 1.",
    shipping_cost: null, shipping_source: null,
  };
  const row = refreshedMateGourdRow(item({ title: "Ceramic Coffee Mug" }), ["mate gourd"], "run-2", existing, ["ceramic"]);
  assert.equal(row.status, "rejected");
  assert.equal(row.reason, "negative_keyword_match");
});

// --- analyzeMateGourdMatch: Gemini prompt/schema construction and response parsing ---

const ENV = { GEMINI_API_KEY: "gemini-key" };
const imageRoute = { test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }) };
const geminiRoute = (body, capture) => ({
  test: (url) => url.includes("generativelanguage.googleapis.com"),
  respond: (url, init) => { if (capture) capture.push(JSON.parse(init.body)); return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }); },
});

async function withFakeBackend(fn) {
  const fake = createFakeSupabase({});
  fake.setRpc("reserve_finder_vision_usage", () => ({ data: { reserved: true }, error: null }));
  fake.setFile("finder-reference-images", "ref1.jpg", [4, 5, 6], "image/png");
  fake.setFile("finder-reference-images", "ref2.jpg", [7, 8, 9], "image/png");
  const restoreFrom = supabaseAdmin.from;
  const restoreRpc = supabaseAdmin.rpc;
  const restoreStorage = supabaseAdmin.storage;
  supabaseAdmin.from = fake.from.bind(fake);
  supabaseAdmin.rpc = fake.rpc.bind(fake);
  supabaseAdmin.storage = fake.storage;
  try { await fn(fake); } finally { supabaseAdmin.from = restoreFrom; supabaseAdmin.rpc = restoreRpc; supabaseAdmin.storage = restoreStorage; }
}

test("analyzeMateGourdMatch sends one text part plus every reference image plus the candidate image, in order", () => {
  return withEnv(ENV, () => withFakeBackend(async () => {
    const requests = [];
    await withFetch([imageRoute, geminiRoute({ matches: true, confidence: 0.92, notes: "Looks like a match." }, requests)], async () => {
      const result = await analyzeMateGourdMatch({
        title: "Antique Silver Mate Gourd", description: "", candidateImageUrl: "https://i.ebayimg.com/x.jpg",
        referenceImages: [{ storagePath: "ref1.jpg" }, { storagePath: "ref2.jpg" }],
      });
      assert.equal(result.matches, true);
      assert.equal(result.confidence, 0.92);
    });
    assert.equal(requests.length, 1);
    const parts = requests[0].contents[0].parts;
    // 1 text part + 2 reference images + 1 candidate image.
    assert.equal(parts.length, 4);
    assert.ok(parts[0].text.includes("2 reference photo"));
    assert.equal(parts[1].inlineData.mimeType, "image/png");
    assert.equal(parts[2].inlineData.mimeType, "image/png");
    assert.equal(parts[3].inlineData.mimeType, "image/jpeg");
  }));
});

test("analyzeMateGourdMatch defaults matchedReferenceIndex to null when Gemini omits it", () => {
  return withEnv(ENV, () => withFakeBackend(async () => {
    await withFetch([imageRoute, geminiRoute({ matches: false, confidence: 0.3, notes: "Doesn't look similar." })], async () => {
      const result = await analyzeMateGourdMatch({
        title: "t", description: "", candidateImageUrl: "https://i.ebayimg.com/x.jpg",
        referenceImages: [{ storagePath: "ref1.jpg" }],
      });
      assert.equal(result.matchedReferenceIndex, null);
    });
  }));
});

test("analyzeMateGourdMatch passes through matchedReferenceIndex when Gemini provides it", () => {
  return withEnv(ENV, () => withFakeBackend(async () => {
    await withFetch([imageRoute, geminiRoute({ matches: true, confidence: 0.95, matchedReferenceIndex: 2, notes: "Matches reference 2." })], async () => {
      const result = await analyzeMateGourdMatch({
        title: "t", description: "", candidateImageUrl: "https://i.ebayimg.com/x.jpg",
        referenceImages: [{ storagePath: "ref1.jpg" }, { storagePath: "ref2.jpg" }],
      });
      assert.equal(result.matchedReferenceIndex, 2);
    });
  }));
});

test("analyzeMateGourdMatch throws when no reference images are configured", () => {
  return withEnv(ENV, () => withFakeBackend(async () => {
    await assert.rejects(
      analyzeMateGourdMatch({ title: "t", description: "", candidateImageUrl: "https://i.ebayimg.com/x.jpg", referenceImages: [] }),
      /No reference images are configured/,
    );
  }));
});
