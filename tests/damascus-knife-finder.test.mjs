import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import {
  analyzeDamascusText,
  calculateDamascusDeal,
  damascusCeiling,
  damascusKnifeGroupForPhrases,
  DAMASCUS_DEFAULTS,
  DAMASCUS_KNIFE_PHRASES,
  evaluateDamascusVision,
  initialDamascusRow,
  refreshedDamascusRow,
} from "../lib/damascus-knife-finder.ts";
import { finderOverview, keywordCategory, processPendingFinderItems, rowCategory, startFinderRun } from "../lib/finder-service.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

const ENV = {
  EBAY_CLIENT_ID: "client-id",
  EBAY_CLIENT_SECRET: "client-secret",
  EBAY_ENVIRONMENT: "sandbox",
  GEMINI_API_KEY: "gemini-key",
  GEMINI_CONFIDENCE_THRESHOLD: "0.90",
  SMTP_HOST: "smtp.gmail.com",
  SMTP_PORT: "587",
  SMTP_USER: "alerts@example.test",
  SMTP_PASSWORD: "app-password",
  FINDER_ALERT_EMAIL_FROM: "alerts@example.test",
  FINDER_ALERT_EMAILS: "owner@example.test",
};

const TOKEN_URL = "https://api.sandbox.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.sandbox.ebay.com/buy/browse/v1/item_summary/search";
const ITEM_URL = "https://api.sandbox.ebay.com/buy/browse/v1/item/";
const tokenRoute = { test: (url) => url.startsWith(TOKEN_URL), respond: () => jsonResponse({ access_token: "fake-token" }) };
const descriptionRoute = (description) => ({ test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ description }) });
const imageRoute = { test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }) };
const geminiRoute = (body) => ({ test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }) });

const settings = DAMASCUS_DEFAULTS;

function item(overrides = {}) {
  return {
    itemId: "v1|1|0", title: "Lot of 5 Damascus Steel Pocket Knives", shortDescription: "", itemWebUrl: "https://www.ebay.com/itm/1",
    imageUrl: "https://i.ebayimg.com/1.jpg", itemPrice: 10, currency: "USD", shippingCost: 4, shippingCurrency: "USD",
    buyingOptions: ["AUCTION"], itemEndDate: null, ...overrides,
  };
}

async function withFakeBackend(seed, fn) {
  const fake = createFakeSupabase(seed);
  fake.setRpc("reserve_finder_vision_usage", () => ({ data: { reserved: true }, error: null }));
  const restoreFrom = supabaseAdmin.from;
  const restoreRpc = supabaseAdmin.rpc;
  supabaseAdmin.from = fake.from.bind(fake);
  supabaseAdmin.rpc = fake.rpc.bind(fake);
  try { await fn(fake); } finally { supabaseAdmin.from = restoreFrom; supabaseAdmin.rpc = restoreRpc; }
}

function mockMailer(t, capture) {
  t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { capture.push(message); return { messageId: "test" }; } }));
}

test("any phrase mentioning damascus is a Damascus phrase, and keywordCategory routes it there without stealing other finders' phrases", () => {
  for (const phrase of DAMASCUS_KNIFE_PHRASES) assert.equal(keywordCategory(phrase), "damascus_knife", phrase);
  assert.equal(keywordCategory("Damascus hunting knife lot"), "damascus_knife");
  assert.equal(keywordCategory("pocket knife lot"), "pocket_knife");
  assert.equal(keywordCategory("sheffield carving set"), "carving_set");
  assert.equal(keywordCategory("mate gourd"), "mate_gourd");
  assert.equal(damascusKnifeGroupForPhrases(["knife lot"]), false);
  assert.equal(rowCategory(["pocket knife lot", "damascus pocket knife lot"]), "damascus_knife");
});

test("ceiling is $3 per standard knife and $6 per kitchen/chef knife, summed for a mixed lot", () => {
  assert.equal(damascusCeiling(5, 0, settings), 15);
  assert.equal(damascusCeiling(5, 5, settings), 30);
  assert.equal(damascusCeiling(4, 3, settings), 21);
  assert.equal(calculateDamascusDeal(12, 3, 5, 0, settings).qualifies, true);
  assert.equal(calculateDamascusDeal(12, 4, 5, 0, settings).reason, "over_budget");
  const kitchen = calculateDamascusDeal(25, 5, 5, 5, settings);
  assert.equal(kitchen.qualifies, true);
  assert.equal(kitchen.costPerKnife, 6);
});

test("analyzeDamascusText resolves counted pocket, bowie, and kitchen listings from text alone", () => {
  const pocket = analyzeDamascusText("Lot of 5 Damascus Steel Pocket Knives");
  assert.equal(pocket.kind, "resolved");
  assert.equal(pocket.count, 5); assert.equal(pocket.kitchenCount, 0); assert.equal(pocket.knifeType, "pocket"); assert.equal(pocket.isSet, true);
  const chef = analyzeDamascusText("Damascus Steel 5 pcs Chef Kitchen Knife Set VG-10 67 Layer");
  assert.equal(chef.kind, "resolved");
  assert.equal(chef.count, 5); assert.equal(chef.kitchenCount, 5); assert.equal(chef.knifeType, "kitchen");
  const bowie = analyzeDamascusText("Custom Handmade Damascus Bowie Knife 12\" w/ Leather Sheath");
  assert.equal(bowie.kind, "resolved");
  assert.equal(bowie.count, 1); assert.equal(bowie.knifeType, "bowie"); assert.equal(bowie.isSet, false);
});

test("analyzeDamascusText never reads layer counts, inch lengths, or steel codes as a knife count", () => {
  const single = analyzeDamascusText("67 Layer VG10 Damascus 8 Inch Chef Knife");
  assert.equal(single.kind, "resolved");
  assert.equal(single.count, 1);
});

test("analyzeDamascusText distrusts a piece count when the set includes a block or other accessories", () => {
  const result = analyzeDamascusText("Damascus 8 Piece Kitchen Knife Set with Wood Block");
  assert.equal(result.kind, "vision");
  assert.equal(result.knownCount, undefined);
  assert.equal(result.isSet, true);
});

test("analyzeDamascusText sends a kitchen set that also includes a pocket knife to vision to split the price tiers", () => {
  const result = analyzeDamascusText("Lot of 4 Damascus Knives - 3 Chef Knives and a Folding Pocket Knife");
  assert.equal(result.kind, "vision");
  assert.equal(result.isSet, true);
});

test("analyzeDamascusText rejects non-Damascus, imitation Damascus, supplies, and non-knife items", () => {
  assert.deepEqual(analyzeDamascusText("Lot of 5 Pocket Knives"), { kind: "reject", reason: "not_damascus" });
  assert.deepEqual(analyzeDamascusText("Damascus Style Etched Pocket Knife Lot of 10"), { kind: "reject", reason: "fake_damascus" });
  assert.deepEqual(analyzeDamascusText("Laser Etched Damascus Pattern Chef Knife"), { kind: "reject", reason: "fake_damascus" });
  assert.deepEqual(analyzeDamascusText("Damascus Steel Billet for Knife Making"), { kind: "reject", reason: "knife_making_supplies" });
  assert.deepEqual(analyzeDamascusText("5 Damascus Knife Blanks"), { kind: "reject", reason: "knife_making_supplies" });
  assert.deepEqual(analyzeDamascusText("Damascus Steel Katana Sword"), { kind: "reject", reason: "not_a_knife" });
  assert.deepEqual(analyzeDamascusText("Damascus Steel Ring Size 10"), { kind: "reject", reason: "not_a_knife" });
  assert.deepEqual(analyzeDamascusText("Set of 3 Damascus Throwing Knives"), { kind: "reject", reason: "throwing_knife" });
});

test("initialDamascusRow never qualifies on the search snippet alone — a would-be qualifier waits for the full-description check", () => {
  const row = initialDamascusRow(item(), ["damascus pocket knife lot"], "run-1", settings, []);
  assert.equal(row.status, "pending");
  assert.equal(row.knife_count, 5);
  assert.equal(row.damascus_description_checked, false);
  assert.equal(row.cost_per_knife, 2.8);
});

test("initialDamascusRow qualifies a cheap lot once its description is checked, tags every row damascus_knife, and flags sets", () => {
  const row = initialDamascusRow(item(), ["damascus pocket knife lot"], "run-1", settings, [], true);
  assert.equal(row.status, "qualified");
  assert.equal(row.item_category, "damascus_knife");
  assert.equal(row.damascus_is_set, true);
  assert.equal(row.cost_per_knife, 2.8);
  const pricey = initialDamascusRow(item({ itemPrice: 20 }), ["damascus pocket knife lot"], "run-1", settings, []);
  assert.equal(pricey.status, "rejected");
  assert.equal(pricey.reason, "over_budget");
  const kitchen = initialDamascusRow(item({ title: "Damascus 5 pcs Chef Knife Set", itemPrice: 20 }), ["damascus chef knife set"], "run-1", settings, [], true);
  assert.equal(kitchen.status, "qualified", "$24 for 5 chef knives fits the $6/knife kitchen ceiling");
});

test("multi-option listings are rejected: a variation item id, or choose-an-option wording", () => {
  const variation = initialDamascusRow(item({ itemId: "v1|198241880099|497362977121", title: "Damascus Steak Knife Set 6 pcs" }), ["damascus steak knife set"], "run-1", settings, []);
  assert.equal(variation.reason, "variation_listing");
  for (const title of ["1-6PCS Kitchen Knife Steak Cleaver Chef Damascus Knives", "Damascus Steak Knife 1PC/3PCS/4PCS/6PCS"]) {
    assert.deepEqual(analyzeDamascusText(title), { kind: "reject", reason: "selection_listing" }, title);
  }
  for (const description of ["1PC/3PCS/4PCS/6PCS Steak Knife (you can choose).", "Please select the set size from the drop down.", "Price is for one knife.", "Knives sold individually."]) {
    assert.deepEqual(analyzeDamascusText("Damascus 6 pcs Steak Knife Set", description), { kind: "reject", reason: "selection_listing" }, description);
  }
  assert.equal(analyzeDamascusText("14PCS Damascus Chef Knife Set", "【IDEAL GIFT CHOICE】This knife set is beautifully crafted.").kind, "resolved", "gift-choice boilerplate isn't a selection listing");
});

test("a search result flagged as part of an item group is a multi-option listing even with a |0 id", () => {
  const row = initialDamascusRow(item({ itemId: "v1|227498700741|0", itemGroupType: "SELLER_DEFINED_VARIATIONS", title: "14PCS Damascus Chef Knife Set" }), ["damascus chef knife set"], "run-1", settings, []);
  assert.equal(row.reason, "variation_listing");
});

test("initialDamascusRow applies staff negative keywords first, and queues ambiguous listings for vision", () => {
  const negative = initialDamascusRow(item({ title: "Damascus Pocket Knife Pendant" }), ["damascus pocket knife"], "run-1", settings, ["pendant"]);
  assert.equal(negative.reason, "negative_keyword_match");
  const ambiguous = initialDamascusRow(item({ title: "Damascus Knives Estate Collection" }), ["damascus knife lot"], "run-1", settings, []);
  assert.equal(ambiguous.status, "pending");
  assert.equal(ambiguous.damascus_is_set, true);
});

test("initialDamascusRow queues a shipping lookup only when the price alone still fits", () => {
  const worthwhile = initialDamascusRow(item({ shippingCost: null }), ["damascus pocket knife lot"], "run-1", settings, []);
  assert.equal(worthwhile.status, "pending");
  assert.equal(worthwhile.knife_count, 5);
  const hopeless = initialDamascusRow(item({ shippingCost: null, itemPrice: 16 }), ["damascus pocket knife lot"], "run-1", settings, []);
  assert.equal(hopeless.reason, "over_budget");
});

test("refreshedDamascusRow reuses a prior vision count, re-priced, instead of re-spending Gemini", () => {
  const existing = { status: "rejected", reason: "over_budget", knife_count: 4, confidence: 0.95, detection_source: "vision", shipping_cost: 5, shipping_source: "listing", damascus_knife_type: "mixed", damascus_kitchen_count: 3, damascus_is_set: true, damascus_notes: "3 chef + 1 folder" };
  const row = refreshedDamascusRow(item({ title: "Damascus Knives Estate Collection", itemPrice: 15, shippingCost: 5 }), ["damascus knife lot"], "run-2", { ...existing, damascus_description_checked: true, short_description: "Full description." }, settings, []);
  assert.equal(row.status, "qualified", "$20 fits 3×$6 + 1×$3 = $21");
  assert.equal(row.short_description, "Full description.", "the fetched full description is kept, not overwritten by the snippet");
  const unchecked = refreshedDamascusRow(item({ title: "Damascus Knives Estate Collection", itemPrice: 15, shippingCost: 5 }), ["damascus knife lot"], "run-2", existing, settings, []);
  assert.equal(unchecked.status, "pending", "still waits for the full-description check");
  assert.equal(row.detection_source, "vision");
  const stillNotDamascus = refreshedDamascusRow(item({ title: "Damascus Knives Estate Collection" }), ["damascus knife lot"], "run-2", { ...existing, reason: "not_damascus_vision" }, settings, []);
  assert.equal(stillNotDamascus.status, "rejected");
  assert.equal(stillNotDamascus.reason, "not_damascus_vision");
});

test("evaluateDamascusVision rejects non-knives, plain blades, and low confidence, and trusts a title-stated count", () => {
  const base = { knifeCount: 6, kitchenKnifeCount: 6, knifeType: "kitchen", isSet: true, bladeLooksNonDamascus: false, confidence: 0.95, notes: "" };
  assert.equal(evaluateDamascusVision(base, undefined, 0.9).reason, null);
  assert.equal(evaluateDamascusVision({ ...base, knifeType: "not_a_knife" }, undefined, 0.9).reason, "not_a_knife");
  assert.equal(evaluateDamascusVision({ ...base, bladeLooksNonDamascus: true }, undefined, 0.9).reason, "not_damascus_vision");
  assert.equal(evaluateDamascusVision({ ...base, confidence: 0.5 }, undefined, 0.9).reason, "low_confidence");
  const known = evaluateDamascusVision(base, 5, 0.9);
  assert.equal(known.knifeCount, 5);
  assert.equal(known.kitchenCount, 5);
});

test("initialDamascusRow rejects items located outside the USA or listed as shipping from overseas", () => {
  const foreign = initialDamascusRow(item({ itemLocationCountry: "PK" }), ["damascus pocket knife lot"], "run-1", settings, []);
  assert.equal(foreign.status, "rejected");
  assert.equal(foreign.reason, "not_us_located");
  const domestic = initialDamascusRow(item({ itemLocationCountry: "US" }), ["damascus pocket knife lot"], "run-1", settings, [], true);
  assert.equal(domestic.status, "qualified");
  const shipsFrom = initialDamascusRow(item({ title: "Lot of 5 Damascus Pocket Knives - Ships from Pakistan" }), ["damascus pocket knife lot"], "run-1", settings, []);
  assert.equal(shipsFrom.reason, "not_us_located");
});

test("a stated lot count is trusted even when the listing mentions sheaths, so sheathed lots resolve from text", () => {
  const result = analyzeDamascusText("LOT OF 60 CUSTOM HANDMADE DAMASCUS STEEL HUNTING SKINNER KNIFE HANDLE CAMEL BONE", "Each knife comes with a leather sheath.");
  assert.equal(result.kind, "resolved");
  assert.equal(result.count, 60);
  const pcs = analyzeDamascusText("Lot of 20 pcs 8in Handmade Damascus Steel Skinner knife with sheath Bone Handle");
  assert.equal(pcs.kind, "resolved");
  assert.equal(pcs.count, 20);
});

test("evaluateDamascusVision applies a lower confidence bar when the title states the quantity (sample photos are normal)", () => {
  const vision = { knifeCount: 1, kitchenKnifeCount: 0, knifeType: "fixed_blade", isSet: true, bladeLooksNonDamascus: false, confidence: 0.8, notes: "Title says lot of 5; photo shows one." };
  assert.equal(evaluateDamascusVision(vision, 5, 0.9).reason, null);
  assert.equal(evaluateDamascusVision(vision, undefined, 0.9).reason, "low_confidence");
});

function pendingItem(overrides = {}) {
  return {
    ebay_item_id: "v1|7|0", run_id: null, title: "Damascus Knives Estate Collection", short_description: "",
    image_url: "https://i.ebayimg.com/7.jpg", item_price: 15, shipping_cost: 5, buying_options: ["AUCTION"], item_category: "damascus_knife",
    keyword_phrases: ["damascus knife lot"], status: "pending", attempts: 0, knife_count: null, damascus_is_set: true,
    next_attempt_at: new Date(Date.now() - 60_000).toISOString(), discovered_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

test("processPendingFinderItems qualifies a mixed Damascus lot on the two-tier ceiling and emails it as a Damascus deal", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({ finder_items: [pendingItem()] }, async (fake) => {
      await withFetch([tokenRoute, imageRoute, descriptionRoute("Four hand-forged Damascus knives from an estate."), geminiRoute({ knifeCount: 4, kitchenKnifeCount: 3, knifeType: "mixed", isSet: true, bladeLooksNonDamascus: false, confidence: 0.95, notes: "3 chef knives and a folder" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [row] = fake.tables.finder_items;
        assert.equal(row.status, "qualified");
        assert.equal(row.damascus_description_checked, true);
        assert.equal(row.damascus_kitchen_count, 3);
        assert.equal(row.cost_per_knife, 5);
        assert.equal(sent.length, 1);
        assert.match(sent[0].subject, /Damascus knife/);
      });
    });
  });
});

test("processPendingFinderItems rejects a would-be qualifier whose full description says the price is for one option", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({ finder_items: [pendingItem({ title: "14PCS Damascus Steak Knife Set", knife_count: 14, damascus_kitchen_count: 14, detection_source: "text", item_price: 20, shipping_cost: 0 })] }, async (fake) => {
      await withFetch([tokenRoute, descriptionRoute("1PC/3PCS/6PCS/14PCS steak knife, you can choose the quantity.")], async () => {
        await processPendingFinderItems(5);
        const [row] = fake.tables.finder_items;
        assert.equal(row.status, "rejected");
        assert.equal(row.reason, "selection_listing");
        assert.equal(row.damascus_description_checked, true);
        assert.equal(sent.length, 0, "no alert email for it");
      });
    });
  });
});

test("processPendingFinderItems rejects a would-be qualifier that the item lookup reports as part of a variation group", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({ finder_items: [pendingItem({ title: "14PCS Damascus Chef Knife Set", knife_count: 14, damascus_kitchen_count: 14, detection_source: "text", item_price: 60, shipping_cost: 0 })] }, async (fake) => {
      await withFetch([tokenRoute, { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ description: "Premium Damascus chef knife set.", primaryItemGroup: { itemGroupId: "227498700741", itemGroupType: "SELLER_DEFINED_VARIATIONS" } }) }], async () => {
        await processPendingFinderItems(5);
        const [row] = fake.tables.finder_items;
        assert.equal(row.status, "rejected");
        assert.equal(row.reason, "variation_listing");
        assert.equal(sent.length, 0);
      });
    });
  });
});

test("processPendingFinderItems treats eBay's 'use the item group endpoint' refusal as a variation listing", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_items: [pendingItem({ title: "14PCS Damascus Chef Knife Set", knife_count: 14, damascus_kitchen_count: 14, detection_source: "text", item_price: 60, shipping_cost: 0 })] }, async (fake) => {
      await withFetch([tokenRoute, { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ errors: [{ errorId: 11006, message: "The legacy ID is invalid. Use the get_items_by_item_group call." }] }, { status: 400 }) }], async () => {
        await processPendingFinderItems(5);
        const [row] = fake.tables.finder_items;
        assert.equal(row.status, "rejected");
        assert.equal(row.reason, "variation_listing");
      });
    });
  });
});

test("processPendingFinderItems sends a text-counted set to vision when the full description shows the piece count includes accessories", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_items: [pendingItem({ title: "14PCS Damascus Chef Knife Set", knife_count: 14, damascus_kitchen_count: 14, detection_source: "text", item_price: 60, shipping_cost: 0 })] }, async (fake) => {
      let geminiCalled = false;
      await withFetch([tokenRoute, descriptionRoute("Set includes 8 knives, a sharpening rod, and a leather roll bag."), { test: (url) => url.includes("generativelanguage"), respond: () => { geminiCalled = true; return jsonResponse({}); } }], async () => {
        await processPendingFinderItems(5);
        const [row] = fake.tables.finder_items;
        assert.equal(row.status, "pending");
        assert.equal(row.knife_count, null, "the title's piece count is no longer trusted");
        assert.equal(row.damascus_description_checked, true);
        assert.equal(geminiCalled, false, "vision runs on the next tick, not this one");
      });
    });
  });
});

test("processPendingFinderItems reports an over-budget listing as over_budget, not low confidence", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_items: [pendingItem({ title: "Damascus Hunting Knives Estate", item_price: 120, shipping_cost: 0 })] }, async (fake) => {
      await withFetch([tokenRoute, imageRoute, geminiRoute({ knifeCount: 5, kitchenKnifeCount: 0, knifeType: "fixed_blade", isSet: true, bladeLooksNonDamascus: false, confidence: 0.6, notes: "unclear" })], async () => {
        await processPendingFinderItems(5);
        const [row] = fake.tables.finder_items;
        assert.equal(row.status, "rejected");
        assert.equal(row.reason, "over_budget", "$120 for 5 knives can't qualify at $3/knife, whatever the confidence");
      });
    });
  });
});

test("processPendingFinderItems drains Damascus sets before single knives", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const older = new Date(Date.now() - 120_000).toISOString();
    await withFakeBackend({
      finder_items: [
        pendingItem({ ebay_item_id: "single", title: "Damascus Knife", damascus_is_set: false, discovered_at: older }),
        pendingItem({ ebay_item_id: "set", damascus_is_set: true }),
      ],
    }, async (fake) => {
      await withFetch([tokenRoute, imageRoute, geminiRoute({ knifeCount: 4, kitchenKnifeCount: 0, knifeType: "pocket", isSet: true, bladeLooksNonDamascus: false, confidence: 0.95, notes: "" })], async () => {
        await processPendingFinderItems(1);
        assert.notEqual(fake.tables.finder_items.find((row) => row.ebay_item_id === "set").status, "pending", "the set is processed first");
        assert.equal(fake.tables.finder_items.find((row) => row.ebay_item_id === "single").status, "pending");
      });
    });
  });
});

test("startFinderRun('damascus_knife') scans only Damascus keywords and stamps its rows damascus_knife, invisible to the pocket-knife dashboard", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "pocket knife lot", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "damascus pocket knife lot", enabled: true, created_at: "2026-01-02" },
      ],
    }, async (fake) => {
      const searched = [];
      const filters = [];
      const searchRoute = { test: (url) => url.startsWith(SEARCH_URL), respond: (url) => {
        searched.push(new URL(url).searchParams.get("q"));
        filters.push(new URL(url).searchParams.get("filter"));
        return jsonResponse({ itemSummaries: [{ itemId: "v1|42|0", title: "Lot of 5 Damascus Steel Pocket Knives", itemWebUrl: "https://www.ebay.com/itm/42", image: { imageUrl: "https://i.ebayimg.com/42.jpg" }, price: { value: "10.00", currency: "USD" }, itemLocation: { country: "US" }, shippingOptions: [{ shippingCost: { value: "4.00", currency: "USD" } }], buyingOptions: ["AUCTION"] }] });
      } };
      await withFetch([tokenRoute, searchRoute], async () => {
        await startFinderRun("manual", undefined, "damascus_knife");
      });
      assert.ok(searched.length > 0);
      assert.ok(searched.every((q) => /damascus/i.test(q)), "only Damascus phrases are searched");
      assert.ok(filters.length > 0 && filters.every((filter) => filter.includes("itemLocationCountry:US")), "every Damascus search is limited to US-located items");
      const [row] = fake.tables.finder_items;
      assert.equal(row.item_category, "damascus_knife");
      assert.equal(row.status, "pending", "waits for the full-description check");
      await withFetch([tokenRoute, descriptionRoute("Five Damascus folding knives, all shown.")], async () => {
        await processPendingFinderItems(5);
      });
      assert.equal(row.status, "qualified");
      const damascus = await finderOverview("damascus_knife");
      assert.equal(damascus.results.length, 1);
      assert.deepEqual(damascus.keywords.map((keyword) => keyword.phrase), ["damascus pocket knife lot"]);
      const pocket = await finderOverview("pocket_knife");
      assert.equal(pocket.results.length, 0);
    });
  });
});
