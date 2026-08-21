import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeGauchoKnifeMatch,
  gauchoKnifeGroupForPhrases,
  imageSearchPhrase,
  initialGauchoKnifeRow,
  matchesNegativeKeyword,
  refreshedGauchoKnifeRow,
} from "../lib/gaucho-knife-finder.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

test("gauchoKnifeGroupForPhrases matches a known positive phrase", () => {
  assert.equal(gauchoKnifeGroupForPhrases(["Franz Wenk"]), true);
  assert.equal(gauchoKnifeGroupForPhrases(["gaucho knife"]), true);
});

test("gauchoKnifeGroupForPhrases matches the synthetic image-search marker", () => {
  assert.equal(gauchoKnifeGroupForPhrases([imageSearchPhrase("some-reference-id")]), true);
});

test("gauchoKnifeGroupForPhrases returns false for an unrelated phrase", () => {
  assert.equal(gauchoKnifeGroupForPhrases(["pocket knife lot"]), false);
  assert.equal(gauchoKnifeGroupForPhrases(["sheffield carving set"]), false);
});

test("matchesNegativeKeyword is case-insensitive and checks title + description", () => {
  assert.equal(matchesNegativeKeyword("Antique Letter Opener", "", ["flatware set"]), null);
  assert.equal(matchesNegativeKeyword("Vintage FLATWARE SET", "", ["flatware set"]), "flatware set");
  assert.equal(matchesNegativeKeyword("Knife", "comes with a full flatware set", ["flatware set"]), "flatware set");
});

test("matchesNegativeKeyword deliberately does not flag common gaucho-knife mislabels", () => {
  // The whole point of the negative-only filter design: real gaucho knives are routinely listed
  // as generic-sounding items, so those exact phrases must never be negative keywords.
  const negatives = ["flatware set", "toy", "replica", "cosplay", "costume"];
  assert.equal(matchesNegativeKeyword("Antique Silver Letter Opener", "", negatives), null);
  assert.equal(matchesNegativeKeyword("Ornate Silver Dagger", "", negatives), null);
});

function item(overrides = {}) {
  return {
    itemId: "v1|111|0", title: "Antique Silver Dagger", shortDescription: "", itemWebUrl: "https://ebay.test/itm/111",
    imageUrl: "https://i.ebayimg.com/x.jpg", itemPrice: 50, shippingCost: 10, shippingCurrency: "USD", currency: "USD",
    buyingOptions: ["FIXED_PRICE"], itemEndDate: null,
    ...overrides,
  };
}

test("initialGauchoKnifeRow rejects a negative-keyword match without needing a photo", () => {
  const row = initialGauchoKnifeRow(item({ title: "Vintage Flatware Set" }), ["gaucho knife"], "run-1", ["flatware set"]);
  assert.equal(row.status, "rejected");
  assert.equal(row.reason, "negative_keyword_match");
});

test("initialGauchoKnifeRow rejects a listing with no photo", () => {
  const row = initialGauchoKnifeRow(item({ imageUrl: null }), ["gaucho knife"], "run-1", []);
  assert.equal(row.status, "rejected");
  assert.equal(row.reason, "missing_image");
});

test("initialGauchoKnifeRow otherwise always lands in pending — there is no text-only qualification path", () => {
  const row = initialGauchoKnifeRow(item(), ["gaucho knife"], "run-1", []);
  assert.equal(row.status, "pending");
  assert.equal(row.item_category, "gaucho_knife");
  assert.equal(row.knife_count, 1);
});

test("initialGauchoKnifeRow computes total_cost for display only, with no gating", () => {
  const row = initialGauchoKnifeRow(item({ itemPrice: 100, shippingCost: 25 }), ["gaucho knife"], "run-1", []);
  assert.equal(row.total_cost, 125);
  assert.equal(row.cost_per_knife, 125);
});

test("refreshedGauchoKnifeRow reuses a prior vision verdict instead of re-spending Gemini, when nothing new rejects it", () => {
  const existing = {
    status: "qualified", reason: null, detection_source: "vision", confidence: 0.92,
    gaucho_match_confidence: 0.92, gaucho_maker_match: true, gaucho_matched_reference_id: "ref-1", gaucho_match_notes: "Matches reference 1.",
    shipping_cost: null, shipping_source: null,
  };
  const row = refreshedGauchoKnifeRow(item(), ["gaucho knife"], "run-2", existing, []);
  assert.equal(row.status, "qualified");
  assert.equal(row.detection_source, "vision");
  assert.equal(row.gaucho_matched_reference_id, "ref-1");
});

test("refreshedGauchoKnifeRow lets a newly-added negative keyword override a stale qualified verdict", () => {
  const existing = {
    status: "qualified", reason: null, detection_source: "vision", confidence: 0.92,
    gaucho_match_confidence: 0.92, gaucho_maker_match: true, gaucho_matched_reference_id: "ref-1", gaucho_match_notes: "Matches reference 1.",
    shipping_cost: null, shipping_source: null,
  };
  const row = refreshedGauchoKnifeRow(item({ title: "Vintage Flatware Set" }), ["gaucho knife"], "run-2", existing, ["flatware set"]);
  assert.equal(row.status, "rejected");
  assert.equal(row.reason, "negative_keyword_match");
});

// --- analyzeGauchoKnifeMatch: Gemini prompt/schema construction and response parsing ---

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

test("analyzeGauchoKnifeMatch sends one text part plus every reference image plus the candidate image, in order", () => {
  return withEnv(ENV, () => withFakeBackend(async () => {
    const requests = [];
    await withFetch([imageRoute, geminiRoute({ matches: true, confidence: 0.8, notes: "Looks like a match." }, requests)], async () => {
      const result = await analyzeGauchoKnifeMatch({
        title: "Antique Silver Dagger", description: "", candidateImageUrl: "https://i.ebayimg.com/x.jpg",
        referenceImages: [{ storagePath: "ref1.jpg" }, { storagePath: "ref2.jpg" }],
      });
      assert.equal(result.matches, true);
      assert.equal(result.confidence, 0.8);
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

test("analyzeGauchoKnifeMatch defaults makerMatch/matchedReferenceIndex to null when Gemini omits them", () => {
  return withEnv(ENV, () => withFakeBackend(async () => {
    await withFetch([imageRoute, geminiRoute({ matches: false, confidence: 0.3, notes: "Doesn't look similar." })], async () => {
      const result = await analyzeGauchoKnifeMatch({
        title: "t", description: "", candidateImageUrl: "https://i.ebayimg.com/x.jpg",
        referenceImages: [{ storagePath: "ref1.jpg" }],
      });
      assert.equal(result.makerMatch, null);
      assert.equal(result.matchedReferenceIndex, null);
    });
  }));
});

test("analyzeGauchoKnifeMatch passes through makerMatch/matchedReferenceIndex when Gemini provides them", () => {
  return withEnv(ENV, () => withFakeBackend(async () => {
    await withFetch([imageRoute, geminiRoute({ matches: true, confidence: 0.95, makerMatch: true, matchedReferenceIndex: 2, notes: "Matches reference 2's maker markings." })], async () => {
      const result = await analyzeGauchoKnifeMatch({
        title: "t", description: "", candidateImageUrl: "https://i.ebayimg.com/x.jpg",
        referenceImages: [{ storagePath: "ref1.jpg" }, { storagePath: "ref2.jpg" }],
      });
      assert.equal(result.makerMatch, true);
      assert.equal(result.matchedReferenceIndex, 2);
    });
  }));
});

test("analyzeGauchoKnifeMatch throws when no reference images are configured", () => {
  return withEnv(ENV, () => withFakeBackend(async () => {
    await assert.rejects(
      analyzeGauchoKnifeMatch({ title: "t", description: "", candidateImageUrl: "https://i.ebayimg.com/x.jpg", referenceImages: [] }),
      /No reference images are configured/,
    );
  }));
});
