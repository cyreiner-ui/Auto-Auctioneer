import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { analyzeCarvingSetText, carvingSetCeiling, carvingSetGroupForPhrases, decideCarvingSetFromText, evaluateCarvingSetVision, initialCarvingSetRow, sheffieldVisionEligible } from "../lib/carving-set-finder.ts";
import { processPendingFinderItems, startFinderRun } from "../lib/finder-service.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

test("analyzeCarvingSetText detects an explicit case, distinct from the Case (brand) name", () => {
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set with Fitted Case").hasCase, true);
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set, cased").hasCase, true);
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set in original box").hasCase, true);
  assert.equal(analyzeCarvingSetText("Case Carving Set").hasCase, false, `"Case" the brand must not be misread as "a case"`);
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set").hasCase, false, "no case wording at all");
});

test("analyzeCarvingSetText detects carbon steel vs stainless material wording", () => {
  const carbon = analyzeCarvingSetText("Sheffield Carving Set carbon steel blade");
  assert.equal(carbon.carbonSteel, true);
  assert.equal(carbon.stainless, false);
  const stainless = analyzeCarvingSetText("German Carving Set stainless steel blade");
  assert.equal(stainless.carbonSteel, false);
  assert.equal(stainless.stainless, true);
  const neither = analyzeCarvingSetText("Antique Sheffield Carving Set");
  assert.equal(neither.carbonSteel, false);
  assert.equal(neither.stainless, false);
});

test("analyzeCarvingSetText extracts an explicit piece count", () => {
  assert.equal(analyzeCarvingSetText("German Carving Set 3 piece cased").pieceCount, 3);
  assert.equal(analyzeCarvingSetText("German Carving Set 5pc boxed").pieceCount, 5);
  assert.equal(analyzeCarvingSetText("German Carving Set boxed").pieceCount, null);
});

test("analyzeCarvingSetText extracts a parenthetical piece count, e.g. \"(2) Piece\"", () => {
  assert.equal(analyzeCarvingSetText("Antique Joseph Rodgers & Sons England Antler Handled (2) Piece Carving Set Good").pieceCount, 2);
});

test("analyzeCarvingSetText flags carving-set phrasing", () => {
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set").isCarvingSet, true);
  assert.equal(analyzeCarvingSetText("Sheffield Carving Knife and Fork Set").isCarvingSet, true);
  assert.equal(analyzeCarvingSetText("Sheffield Carving Knife & Fork").isCarvingSet, true);
  assert.equal(analyzeCarvingSetText("Sheffield Pocket Knife Lot").isCarvingSet, false);
});

test("analyzeCarvingSetText flags \"carving knife fork\" phrasing with no \"and\"/\"&\" conjunction, a common seller phrasing this used to miss entirely", () => {
  assert.equal(analyzeCarvingSetText("Joseph Rodgers Sheffield England Antler Carving Knife Fork Steel Box Antique Set").isCarvingSet, true);
  assert.equal(analyzeCarvingSetText("Regent Sheffield Carving Knife Fork Set Stainless Steel Wood Handle 10.5\" Blade").isCarvingSet, true);
});

test("decideCarvingSetFromText: \"no deep gouges\"/other cutlery condition-report wording no longer false-rejects as a wood-carving tool", () => {
  // Verbatim from a production Rehwappen stag-handle carving set that was wrongly rejected as
  // wood_carving_tool solely because its condition report said "No deep gouges or structural damage".
  const title = "Vtg Rehwappen Solingen Stag Carving Set Knife 12.5\" German Hunting Shop Boxed";
  const description = "Handles: 100% Genuine, rugged natural stag antler horn handles. Metal Condition: The knife blade shows some light, non-deep superficial hairline scratches/scuffs on the finish from age and storage handling. No deep gouges or structural damage.";
  for (const group of ["sheffield", "german", "generic"]) {
    const decision = decideCarvingSetFromText(title, description, group, 115, 0);
    assert.notEqual(decision.reason, "wood_carving_tool", `${group}: "no deep gouges" is condition wording, not a woodworking-tool signal`);
  }
});

test("analyzeCarvingSetText: stagHandle is \"stag\" only for a genuine (non-faux) stag/antler mention", () => {
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set, Stag Horn Handle, cased").stagHandle, "stag");
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set, Antler Handle, cased").stagHandle, "stag");
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set, Faux Stag Horn Handle, cased").stagHandle, "other", "\"faux\" stag is not a genuine stag handle");
});

test("analyzeCarvingSetText: stagHandle is \"other\" for an explicit competing handle material", () => {
  for (const material of ["bone handle", "ivory handle", "mother of pearl handle", "pearl handle", "celluloid handle", "bakelite handle", "plastic handle", "wood handle", "wooden handle", "delrin handle", "micarta handle", "g10 handle", "synthetic handle"]) {
    assert.equal(analyzeCarvingSetText(`Sheffield Carving Set, ${material}, cased`).stagHandle, "other", `"${material}" should reject as a competing material`);
  }
});

test("analyzeCarvingSetText: stagHandle is \"ambiguous\" when the text says nothing about handle material", () => {
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set, cased").stagHandle, "ambiguous");
});

test("carvingSetGroupForPhrases: a brand-specific generic phrase resolves to \"generic\", and the disabled legacy bare phrase still resolves too", () => {
  assert.equal(carvingSetGroupForPhrases(["elkington carving set"]), "generic");
  assert.equal(carvingSetGroupForPhrases(["mappin and webb carving set"]), "generic");
  assert.equal(carvingSetGroupForPhrases(["carving set"]), "generic", "the disabled legacy phrase must still resolve, so old rows re-evaluate on rescan instead of leaking into the pocket-knife pipeline");
  assert.equal(carvingSetGroupForPhrases(["sheffield carving set"]), "sheffield");
  assert.equal(carvingSetGroupForPhrases(["german carving set"]), "german");
  assert.equal(carvingSetGroupForPhrases(["old timer knife lot"]), null);
});

test("decideCarvingSetFromText rejects modern-manufacture wording, for every group", () => {
  for (const group of ["sheffield", "german", "generic"]) {
    for (const title of ["Elkington Carving Set, Made in USA, cased", "Elkington Carving Set, Japanese Stainless, cased", "Elkington Carving Set, American Made, cased"]) {
      const decision = decideCarvingSetFromText(title, "", group, 50, 0);
      assert.equal(decision.kind, "reject", `"${title}" (${group}) should reject`);
      assert.equal(decision.reason, "modern_origin", `"${title}" (${group}) should reject as modern_origin`);
    }
  }
});

test("decideCarvingSetFromText rejects wood-carving/whittling tool kits, for every group", () => {
  for (const group of ["sheffield", "german", "generic"]) {
    for (const title of ["BeaverCraft S13 Wood Carving Set, Whittling Knife Kit", "Flexcut Detail Knife Carving Set 5pc", "Basswood Chip Carving Set, 6 gouges"]) {
      const decision = decideCarvingSetFromText(title, "", group, 50, 0);
      assert.equal(decision.kind, "reject", `"${title}" (${group}) should reject`);
      assert.equal(decision.reason, "wood_carving_tool", `"${title}" (${group}) should reject as wood_carving_tool`);
    }
  }
});

test("decideCarvingSetFromText rejects an explicit non-stag handle, for every group", () => {
  for (const group of ["sheffield", "german", "generic"]) {
    const decision = decideCarvingSetFromText("Elkington Carving Set, Bone Handle, cased", "", group, 50, 0);
    assert.equal(decision.kind, "reject");
    assert.equal(decision.reason, "not_stag_handle");
  }
});

test("decideCarvingSetFromText: falling back to vision still carries forward whatever text already confirmed, for every group", () => {
  for (const group of ["sheffield", "german", "generic"]) {
    // Stag confirmed by text, case not mentioned at all — matches the production titles that were
    // wrongly rejected as not_stag_handle_vision (e.g. "Joseph Rodgers ... stag horn ... carving set").
    const stagOnly = decideCarvingSetFromText("Joseph Rodgers and Sons stag horn Victorian Era four piece carving set", "", group, 150, 0);
    assert.equal(stagOnly.kind, "vision");
    assert.equal(stagOnly.stagConfirmed, true);
    assert.equal(stagOnly.caseConfirmed, false);

    // Case confirmed by text, stag not mentioned — the symmetric case.
    const caseOnly = decideCarvingSetFromText("Elkington Carving Set, cased", "", group, 150, 0);
    assert.equal(caseOnly.kind, "vision");
    assert.equal(caseOnly.caseConfirmed, true);
    assert.equal(caseOnly.stagConfirmed, false);
  }
});

test("decideCarvingSetFromText: German/generic only resolve from text alone once a stag handle is confirmed — an ambiguous handle falls to vision instead of qualifying", () => {
  for (const group of ["german", "generic"]) {
    const ambiguous = decideCarvingSetFromText("Elkington Carving Set 3 piece, cased", "", group, 40, 0);
    assert.equal(ambiguous.kind, "vision", `${group}: case/piece count alone must not resolve without a confirmed stag handle`);
    const confirmed = decideCarvingSetFromText("Elkington Carving Set 3 piece, Stag Horn Handle, cased", "", group, 40, 0);
    assert.equal(confirmed.kind, "resolved", `${group}: a confirmed stag handle lets text resolve as before`);
    assert.equal(confirmed.qualifies, true);
  }
});

test("initialCarvingSetRow rejects a cased, well-priced listing that never actually says \"carving set\", since eBay's free-text search can surface non-carving-set items for these keywords", () => {
  const parsed = {
    itemId: "v1|not-carving-set|0", title: "Sheffield England Pocket Knife With Fitted Case", shortDescription: "",
    itemWebUrl: "https://www.ebay.com/itm/not-carving-set", imageUrl: "https://i.ebayimg.com/not-carving-set.jpg",
    itemPrice: 50, shippingCost: 0, shippingCurrency: "USD", currency: "USD", buyingOptions: ["FIXED_PRICE"], itemEndDate: null,
  };
  const sheffieldRow = initialCarvingSetRow(parsed, ["sheffield carving set"], "run-1", "sheffield");
  assert.equal(sheffieldRow.status, "rejected");
  assert.equal(sheffieldRow.reason, "not_carving_set");
  const germanRow = initialCarvingSetRow(parsed, ["german carving set"], "run-1", "german");
  assert.equal(germanRow.status, "rejected");
  assert.equal(germanRow.reason, "not_carving_set");
});

test("carvingSetCeiling: Sheffield is always $200 regardless of piece count", () => {
  assert.equal(carvingSetCeiling("sheffield", null), 200);
  assert.equal(carvingSetCeiling("sheffield", 2), 200);
  assert.equal(carvingSetCeiling("sheffield", 5), 200);
});

test("carvingSetCeiling: German is tiered by piece count at $10/piece + $15", () => {
  assert.equal(carvingSetCeiling("german", 2), 35);
  assert.equal(carvingSetCeiling("german", 3), 45);
  assert.equal(carvingSetCeiling("german", 4), 55);
  assert.equal(carvingSetCeiling("german", 5), 65);
  assert.equal(carvingSetCeiling("german", 6), 75);
});

test("carvingSetCeiling: German returns null when the piece count isn't resolvable", () => {
  assert.equal(carvingSetCeiling("german", null), null);
  assert.equal(carvingSetCeiling("german", 1), null, "a single piece isn't a genuine carving set");
});

test("sheffieldVisionEligible: only more than 30 qualified results unlock vision", () => {
  assert.equal(sheffieldVisionEligible(0), false);
  assert.equal(sheffieldVisionEligible(30), false, "exactly 30 is not \"more than\" 30");
  assert.equal(sheffieldVisionEligible(31), true);
});

function visionResult(overrides = {}) {
  return { hasCase: true, pieceCount: 2, confidence: 0.95, uncertaintyReason: "", material: "carbon_steel", handleMaterial: "stag", ...overrides };
}

// Text confirmed neither case nor stag — isolates vision's own decision logic, same as every test
// below except the ones specifically about the text-confirmed-overrides-vision behavior.
const NOTHING_FROM_TEXT = { hasCase: false, stag: false };

test("evaluateCarvingSetVision: a confident stainless_steel reading rejects a Sheffield item", () => {
  const decision = evaluateCarvingSetVision("sheffield", visionResult({ material: "stainless_steel" }), 0.9, NOTHING_FROM_TEXT);
  assert.equal(decision.reason, "stainless_steel_vision");
});

test("evaluateCarvingSetVision: a confident carbon_steel reading does not reject a cased Sheffield item", () => {
  const decision = evaluateCarvingSetVision("sheffield", visionResult({ material: "carbon_steel" }), 0.9, NOTHING_FROM_TEXT);
  assert.equal(decision.reason, null);
});

test("evaluateCarvingSetVision: an indeterminate material reading does not reject a cased Sheffield item", () => {
  const decision = evaluateCarvingSetVision("sheffield", visionResult({ material: "indeterminate" }), 0.9, NOTHING_FROM_TEXT);
  assert.equal(decision.reason, null);
});

test("evaluateCarvingSetVision: German ignores the material field entirely", () => {
  const decision = evaluateCarvingSetVision("german", visionResult({ material: "stainless_steel", pieceCount: 3 }), 0.9, NOTHING_FROM_TEXT);
  assert.notEqual(decision.reason, "stainless_steel_vision");
  assert.equal(decision.reason, null, "hasCase true and a resolvable German ceiling qualifies regardless of material");
});

test("evaluateCarvingSetVision: only a confident \"stag\" handleMaterial reading passes, for every group, when text confirmed nothing", () => {
  for (const group of ["sheffield", "german", "generic"]) {
    assert.equal(evaluateCarvingSetVision(group, visionResult({ handleMaterial: "other" }), 0.9, NOTHING_FROM_TEXT).reason, "not_stag_handle_vision", `${group}: "other" must reject`);
    assert.equal(evaluateCarvingSetVision(group, visionResult({ handleMaterial: "indeterminate" }), 0.9, NOTHING_FROM_TEXT).reason, "not_stag_handle_vision", `${group}: "indeterminate" doesn't confirm stag either, unlike the material field's default-accept`);
    assert.equal(evaluateCarvingSetVision(group, visionResult({ handleMaterial: "stag" }), 0.9, NOTHING_FROM_TEXT).reason, null, `${group}: a confident "stag" reading passes`);
  }
});

test("evaluateCarvingSetVision: a text-confirmed stag handle survives even when vision's own photo read disagrees or is unsure", () => {
  for (const group of ["sheffield", "german", "generic"]) {
    for (const handleMaterial of ["other", "indeterminate", "stag"]) {
      const decision = evaluateCarvingSetVision(group, visionResult({ handleMaterial }), 0.9, { hasCase: false, stag: true });
      assert.notEqual(decision.reason, "not_stag_handle_vision", `${group}/${handleMaterial}: text already confirmed stag, vision must not override it`);
      assert.equal(decision.stagConfirmed, true);
    }
  }
});

test("evaluateCarvingSetVision: a text-confirmed case survives even when vision says no case", () => {
  for (const group of ["sheffield", "german", "generic"]) {
    const decision = evaluateCarvingSetVision(group, visionResult({ hasCase: false }), 0.9, { hasCase: true, stag: true });
    assert.notEqual(decision.reason, "no_case", `${group}: text already confirmed a case, vision must not override it`);
    assert.equal(decision.hasCase, true);
  }
});

test("evaluateCarvingSetVision: without any text confirmation, vision's own no-case/no-stag readings still reject as before", () => {
  const noCase = evaluateCarvingSetVision("german", visionResult({ hasCase: false }), 0.9, NOTHING_FROM_TEXT);
  assert.equal(noCase.reason, "no_case");
  const noStag = evaluateCarvingSetVision("german", visionResult({ handleMaterial: "other" }), 0.9, NOTHING_FROM_TEXT);
  assert.equal(noStag.reason, "not_stag_handle_vision");
});

// --- Integration: dispatch through startFinderRun/processPendingFinderItems, exercising the
// separate carving-set algorithm end to end alongside the (untouched) pocket-knife pipeline. ---

const ENV = {
  EBAY_CLIENT_ID: "client-id",
  EBAY_CLIENT_SECRET: "client-secret",
  EBAY_ENVIRONMENT: "sandbox",
  EBAY_FINDER_MAX_PER_KNIFE: "3.50",
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
const imageRoute = { test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }) };
const geminiRoute = (body) => ({ test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }) });
// processCarvingSetRow now fetches the item's full description (lazily, one row at a time) before
// ever falling through to vision — see the comment above that fetch in lib/finder-service.ts.
// Every pending-queue vision test needs this mocked too, alongside imageRoute/geminiRoute.
const descriptionRoute = { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ description: "" }) };

function carvingItem(overrides = {}) {
  return {
    itemId: "v1|carving|0",
    title: "Sheffield Carving Set",
    shortDescription: "",
    itemWebUrl: "https://www.ebay.com/itm/carving",
    image: { imageUrl: "https://i.ebayimg.com/carving.jpg" },
    price: { value: "180.00", currency: "USD" },
    shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
    buyingOptions: ["FIXED_PRICE"],
    ...overrides,
  };
}

async function withFakeBackend(seed, fn) {
  const fake = createFakeSupabase(seed);
  fake.setRpc("reserve_finder_vision_usage", () => ({ data: { reserved: true }, error: null }));
  const restoreFrom = supabaseAdmin.from;
  const restoreRpc = supabaseAdmin.rpc;
  supabaseAdmin.from = fake.from.bind(fake);
  supabaseAdmin.rpc = fake.rpc.bind(fake);
  try {
    await fn(fake);
  } finally {
    supabaseAdmin.from = restoreFrom;
    supabaseAdmin.rpc = restoreRpc;
  }
}

function mockMailer(t, capture) {
  t.mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message) => { capture.push(message); return { messageId: "test" }; },
  }));
}

test("initialCarvingSetRow leaves a cased, carbon-steel-worded Sheffield set pending for a vision material check instead of qualifying from text alone", () => {
  const item = carvingItem({
    title: "Antique Sheffield Carving Set, carbon steel blade, with fitted case",
    price: { value: "180.00", currency: "USD" },
  });
  const parsed = { itemId: item.itemId, title: item.title, shortDescription: item.shortDescription, itemWebUrl: item.itemWebUrl, imageUrl: item.image.imageUrl, itemPrice: 180, shippingCost: 0, shippingCurrency: "USD", currency: "USD", buyingOptions: item.buyingOptions, itemEndDate: null };
  const row = initialCarvingSetRow(parsed, ["sheffield carving set"], "run-1", "sheffield");
  // Text confirms case and no negative material signal fired, but that only means material is
  // *assumed* carbon steel, never *confirmed* — every surviving Sheffield candidate must still get
  // a vision material check (see analyzeCarvingSetWithGemini) before it can qualify, even though
  // its case/ceiling are already fully known from text. This is exactly what closes the bug where a
  // listing whose only "stainless" evidence was on the physical knife, not in the seller's prose,
  // slipped through unchecked as "carbon steel".
  assert.equal(row.status, "pending");
  assert.equal(row.reason, null);
  assert.equal(row.item_category, "carving_set");
  assert.equal(row.carving_carbon_steel, true, "assumed carbon steel pending vision confirmation");
  assert.equal(row.knife_count, undefined, "must not be finalized as knife_count 1 without a vision check");
});

test("startFinderRun rejects a Sheffield carving set explicitly described as stainless steel", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          title: "Antique Sheffield Carving Set, stainless steel blade, with fitted case",
          price: { value: "50.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-stainless");
        assert.equal(run.qualified, 0);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "stainless_steel", "only carbon steel Sheffield sets qualify, no matter how cheap");
      });
    });
  });
});

test("startFinderRun rejects a Sheffield carving set that mentions \"stainless\" even alongside \"carbon steel\" in the same listing", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          title: "Antique Sheffield Carving Set, carbon steel blade, stainless bolsters, with fitted case",
          price: { value: "50.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-stainless-and-carbon");
        assert.equal(run.qualified, 0);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "stainless_steel", "\"stainless\" is an unconditional negative keyword now, even when \"carbon steel\" is also mentioned");
      });
    });
  });
});

test("initialCarvingSetRow: a Sheffield set mentioning neither carbon steel nor stainless still gets left pending (not rejected) for vision, not required to state \"carbon steel\" explicitly", () => {
  const item = carvingItem({ title: "Antique Sheffield Carving Set, with fitted case", price: { value: "180.00", currency: "USD" } });
  const parsed = { itemId: item.itemId, title: item.title, shortDescription: item.shortDescription, itemWebUrl: item.itemWebUrl, imageUrl: item.image.imageUrl, itemPrice: 180, shippingCost: 0, shippingCurrency: "USD", currency: "USD", buyingOptions: item.buyingOptions, itemEndDate: null };
  const row = initialCarvingSetRow(parsed, ["sheffield carving set"], "run-1", "sheffield");
  assert.equal(row.status, "pending", "most real listings say neither word, so this must not be rejected for lacking an explicit \"carbon steel\" match");
  assert.equal(row.carving_carbon_steel, true, "assumed carbon steel pending vision confirmation");
});

test("startFinderRun rejects a Sheffield carving set from a known-stainless-only maker, even with no material wording at all", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          title: "Regent Sheffield Carving Set, with fitted case",
          price: { value: "50.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-negative-brand");
        assert.equal(run.qualified, 0);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "stainless_steel", "Regent is a known-stainless-only maker, regardless of the (absent) material wording");
      });
    });
  });
});

test("negative-keyword brands (Crown Crest, Lewis Rose & Co, Landers Frary & Clark, Sherwood, Tramontina, Ekco, Rogers Bros, Lamson, Cheltenham, Trustwell Bros, Westall Richardson, Hallmark Blades, McClory/Scotia) all reject a Sheffield carving set", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const brands = [
      "Crown Crest", "Crowncrest", "Lewis Rose & Co", "Lewis Rose and Co.",
      // The comma-punctuated form is the exact miss found in production ("Lewis, Rose & Co. Ltd."
      // slipped through qualified before the separator was widened from `\s*` to `[\s,]*`).
      "Lewis, Rose & Co. Ltd.",
      "Landers, Frary & Clark", "Landers Frary", "Sherwood", "Tramontina", "Ekco", "Rogers Bros", "Wm Rogers", "Lamson", "Lamson & Goodnow",
      "Cheltenham", "Trustwell Brothers", "Trustwell Bros.", "Westall Richardson", "Hallmark Blades", "John McClory & Sons", "Scotia",
    ];
    for (const brand of brands) {
      await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
        await withFetch([
          tokenRoute,
          { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
            itemId: `v1|${brand}|0`, itemWebUrl: `https://www.ebay.com/itm/${encodeURIComponent(brand)}`,
            title: `${brand} Sheffield Carving Set, with fitted case`,
            price: { value: "50.00", currency: "USD" },
          })] }) },
        ], async () => {
          await startFinderRun("manual", `run-carving-brand-${brand}`);
          const [item] = fake.tables.finder_items;
          assert.equal(item.status, "rejected", `"${brand}" should reject`);
          assert.equal(item.reason, "stainless_steel", `"${brand}" should reject as stainless_steel`);
        });
      });
    }
  });
});

test("era/style wording (MCM, Mid Century Modern, Midcentury, Danish) rejects a Sheffield carving set as stainless_era_wording, even with no brand match", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const titles = [
      "Sheffield England MCM Carving Set, with fitted case",
      "Sheffield England Mid Century Modern Carving Set, with fitted case",
      "Sheffield England Midcentury Carving Set, with fitted case",
      "Sheffield England Danish Wheat Carving Set, with fitted case",
    ];
    for (const title of titles) {
      await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
        await withFetch([
          tokenRoute,
          { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
            itemId: `v1|${title}|0`, itemWebUrl: `https://www.ebay.com/itm/${encodeURIComponent(title)}`,
            title, price: { value: "50.00", currency: "USD" },
          })] }) },
        ], async () => {
          await startFinderRun("manual", `run-carving-era-${title}`);
          const [item] = fake.tables.finder_items;
          assert.equal(item.status, "rejected", `"${title}" should reject`);
          assert.equal(item.reason, "stainless_era_wording", `"${title}" should reject as stainless_era_wording`);
        });
      });
    }
  });
});

test("\"faux\" handle material rejects a Sheffield carving set as faux_handle, even with no brand or era match", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          title: "Sheffield Carving Set, Faux Stag Horn Handle, with fitted case",
          price: { value: "50.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-faux-handle");
        assert.equal(run.qualified, 0);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "faux_handle");
      });
    });
  });
});

test("initialCarvingSetRow: a genuine antique Sheffield carving set (real stag horn, sterling silver, no brand/era/faux wording) is left pending, not over-rejected by the new patterns", () => {
  const item = carvingItem({
    title: "Antique Walker and Hall Sheffield Stag Horn & Sterling Silver Carving Set W/Case",
    shortDescription: "Beautiful original condition, real stag horn handle, with its original case.",
    price: { value: "77.50", currency: "USD" },
  });
  const parsed = { itemId: item.itemId, title: item.title, shortDescription: item.shortDescription, itemWebUrl: item.itemWebUrl, imageUrl: item.image.imageUrl, itemPrice: 77.5, shippingCost: 0, shippingCurrency: "USD", currency: "USD", buyingOptions: item.buyingOptions, itemEndDate: null };
  const row = initialCarvingSetRow(parsed, ["sheffield carving set"], "run-1", "sheffield");
  assert.equal(row.status, "pending", "the one confirmed-good result from this batch must not be over-rejected by the new patterns");
  assert.equal(row.reason, null);
  assert.equal(row.carving_carbon_steel, true);
});

test("era/style wording never rejects a German carving set (no material restriction for that group)", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "german carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|german-mcm|0", itemWebUrl: "https://www.ebay.com/itm/german-mcm",
          title: "Solingen MCM Danish 3 piece Carving Set, Stag Horn Handle, cased",
          price: { value: "40.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-german-mcm");
        assert.equal(run.qualified, 1, "German carving sets have no material restriction, so era wording must not reject them");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.carving_carbon_steel, null);
        assert.equal(item.carving_stag_handle, true);
      });
    });
  });
});

test("a \"faux\" stag handle rejects a German carving set too, since the stag-handle requirement applies to every group, not just Sheffield", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "german carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|german-faux|0", itemWebUrl: "https://www.ebay.com/itm/german-faux",
          title: "Solingen 3 piece Carving Set, Faux Stag Horn Handle, cased",
          price: { value: "40.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-german-faux");
        assert.equal(run.qualified, 0);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "not_stag_handle");
      });
    });
  });
});

test("startFinderRun qualifies a German carving set under the tiered $10/piece + $15 ceiling", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "german carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|german|0", itemWebUrl: "https://www.ebay.com/itm/german",
          title: "Wusthof 3 piece Carving Set, Stag Horn Handle, cased",
          price: { value: "40.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-german");
        assert.equal(run.qualified, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.carving_piece_count, 3);
        assert.equal(item.total_cost, 40);
        assert.ok(item.total_cost <= 45, "3 pieces should cap at $45 (10*3+15)");
      });
    });
  });
});

test("startFinderRun rejects a German carving set over its tiered ceiling", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "german carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|german-over|0", itemWebUrl: "https://www.ebay.com/itm/german-over",
          title: "Wusthof 2 piece Carving Set, Stag Horn Handle, cased",
          price: { value: "60.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-german-over");
        assert.equal(run.qualified, 0);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "over_budget", "2 pieces caps at $35 (10*2+15), $60 is over");
      });
    });
  });
});

function shefCasedItem(index) {
  return carvingItem({
    itemId: `v1|sheffield-vol-${index}|0`,
    itemWebUrl: `https://www.ebay.com/itm/sheffield-vol-${index}`,
    title: "Sheffield Carving Set with Fitted Case",
    price: { value: "150.00", currency: "USD" },
    shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
  });
}

// Every Sheffield candidate that passes the text checks now needs a vision material check (see
// initialCarvingSetRow), so a text-cased item and a case-ambiguous one are treated identically by
// the volume gate below — both land in status "pending" with knife_count unset. The gate's "how
// many good leads did this run find" signal is now the count of those pending rows (see
// lib/finder-service.ts's startFinderRun), not a literal "qualified" count.
test("startFinderRun rejects every Sheffield candidate without spending a vision call when this run's pending-for-vision count is 30 or fewer", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    let geminiCalled = false;
    const casedItems = Array.from({ length: 30 }, (_, index) => shefCasedItem(index));
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: casedItems }) },
        { test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => { geminiCalled = true; return jsonResponse({}); } },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-low-volume");
        assert.equal(run.qualified, 0, "exactly 30 pending-for-vision candidates is not \"more than\" 30");
        assert.equal(fake.tables.finder_items.length, 30);
        for (const row of fake.tables.finder_items) {
          assert.equal(row.status, "rejected");
          assert.equal(row.reason, "low_volume_skip_vision");
        }
        assert.equal(geminiCalled, false, "Gemini must never be spent when this run's pending-for-vision count doesn't exceed 30");
      });
    });
  });
});

test("startFinderRun leaves every Sheffield candidate pending for vision once this run's pending-for-vision count exceeds 30, and vision then confirms carbon steel to qualify them", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const casedItems = Array.from({ length: 31 }, (_, index) => shefCasedItem(index));
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: casedItems }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-high-volume");
        assert.equal(run.qualified, 0, "text alone never finalizes a Sheffield row anymore, even once the volume gate opens");
        assert.equal(fake.tables.finder_items.length, 31);
        for (const row of fake.tables.finder_items) assert.equal(row.status, "pending", "more than 30 pending-for-vision candidates leaves every one of them eligible for vision");
      });
      await withFetch([tokenRoute, imageRoute, descriptionRoute, geminiRoute({ hasCase: true, pieceCount: 2, confidence: 0.95, uncertaintyReason: "", material: "carbon_steel", handleMaterial: "stag" })], async () => {
        const { processed } = await processPendingFinderItems(40);
        assert.equal(processed, 31);
        for (const row of fake.tables.finder_items) {
          assert.equal(row.status, "qualified");
          assert.equal(row.detection_source, "vision");
          assert.equal(row.carving_carbon_steel, true);
          assert.equal(row.carving_stag_handle, true);
        }
      });
    });
  });
});

test("processPendingFinderItems rejects a Sheffield set as stainless_steel_vision when vision overturns the text-assumed carbon steel default, closing the gap that let a physically-stainless set through as \"carbon steel\"", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|vision-stainless|0", run_id: null, keyword_phrases: ["sheffield carving set"],
        title: "Antique Sheffield Carving Set, with fitted case", short_description: "",
        // Simulates the row initialCarvingSetRow now leaves behind for a cased Sheffield candidate
        // with no negative text signal — case known, material only assumed (true), pending vision.
        carving_carbon_steel: true, carving_has_case: true,
        image_url: "https://i.ebayimg.com/vision-stainless.jpg", item_price: 150, shipping_cost: 10, buying_options: ["FIXED_PRICE"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([tokenRoute, imageRoute, descriptionRoute, geminiRoute({ hasCase: true, pieceCount: 2, confidence: 0.95, uncertaintyReason: "", material: "stainless_steel", handleMaterial: "stag" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "stainless_steel_vision");
        assert.equal(item.carving_carbon_steel, false, "the persisted material must reflect the vision-confirmed stainless verdict, overturning the text-assumed default");
      });
    });
  });
});

test("the Sheffield volume gate never applies to German carving sets", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "german carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|german-ambiguous|0", itemWebUrl: "https://www.ebay.com/itm/german-ambiguous",
          title: "Wusthof Carving Set, cased", // cased, but no piece count wording -> ambiguous, falls to vision
          price: { value: "40.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-german-ambiguous");
        assert.equal(run.qualified, 0, "no Sheffield items at all in this run, so a wrongly-shared gate would have something to reject against");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "pending", "German case/piece-ambiguous items still fall to vision regardless of run volume");
      });
    });
  });
});

test("processPendingFinderItems falls back to vision when the case isn't mentioned in text, and rejects if vision finds no case", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|no-case|0", run_id: null, keyword_phrases: ["sheffield carving set"],
        title: "Antique Sheffield Carving Set", short_description: "",
        // Material is always resolved at discovery, before an item can ever reach "pending" —
        // this row simulates that prior resolution (default-accepted, no negative brand/wording).
        carving_carbon_steel: true,
        image_url: "https://i.ebayimg.com/nocase.jpg", item_price: 50, shipping_cost: 0, buying_options: ["FIXED_PRICE"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([tokenRoute, imageRoute, descriptionRoute, geminiRoute({ hasCase: false, pieceCount: 2, confidence: 0.95, uncertaintyReason: "", material: "carbon_steel", handleMaterial: "stag" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "no_case", "the case requirement is hard even when confirmed via vision instead of text");
        assert.equal(item.detection_source, "vision");
        assert.equal(item.item_category, "carving_set");
        assert.equal(item.knife_count, 1);
      });
    });
  });
});

test("processPendingFinderItems qualifies a Sheffield set via vision once case is confirmed, carrying forward the material already resolved from text", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|vision-ok|0", run_id: null, keyword_phrases: ["sheffield carving set"],
        title: "Antique Sheffield Carving Set", short_description: "",
        carving_carbon_steel: true,
        image_url: "https://i.ebayimg.com/visionok.jpg", item_price: 150, shipping_cost: 10, buying_options: ["FIXED_PRICE"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([tokenRoute, imageRoute, descriptionRoute, geminiRoute({ hasCase: true, pieceCount: 2, confidence: 0.95, uncertaintyReason: "", material: "carbon_steel", handleMaterial: "stag" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.total_cost, 160);
        assert.equal(item.carving_has_case, true);
        assert.equal(item.carving_carbon_steel, true, "a confident carbon_steel vision reading doesn't overturn the row's already-resolved material");
        assert.equal(item.carving_stag_handle, true);
      });
    });
  });
});

test("processPendingFinderItems fetches the full description first and rejects a Sheffield set as stainless_steel from text alone, without ever spending a vision call", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        // eBay's search endpoint returned a blank shortDescription, so this row reached "pending"
        // with material merely assumed (carving_carbon_steel: true) — the same shape startFinderRun
        // now always leaves behind for a carving-set item, since the description fetch that used to
        // happen eagerly during the scan happens here instead (see the comment on the removed
        // scan-time fetch in startFinderRun).
        ebay_item_id: "v1|lazy-stainless|0", run_id: null, keyword_phrases: ["sheffield carving set"],
        title: "Antique Sheffield Carving Set, with fitted case", short_description: "",
        carving_carbon_steel: true,
        image_url: "https://i.ebayimg.com/lazy-stainless.jpg", item_price: 150, shipping_cost: 10, buying_options: ["FIXED_PRICE"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      const fullDescriptionRoute = { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ description: "Blade stamped STAINLESS STEEL, Sheffield England." }) };
      await withFetch([tokenRoute, fullDescriptionRoute], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "stainless_steel", "resolved from the newly-fetched description, no vision call needed (none was mocked)");
        assert.equal(item.short_description, "Blade stamped STAINLESS STEEL, Sheffield England.", "the fetched description is persisted, not left blank");
      });
    });
  });
});

test("processPendingFinderItems fetches the full description first and qualifies a German set from text alone once it reveals a case and piece count, without ever spending a vision call", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|lazy-german|0", run_id: null, keyword_phrases: ["german carving set"],
        title: "Wusthof Carving Set", short_description: "",
        image_url: "https://i.ebayimg.com/lazy-german.jpg", item_price: 40, shipping_cost: 0, buying_options: ["FIXED_PRICE"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      const fullDescriptionRoute = { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ description: "This 3 piece set comes cased, with a stag horn handle, in excellent condition." }) };
      await withFetch([tokenRoute, fullDescriptionRoute], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified", "3 pieces caps at $45 (10*3+15), $40 total qualifies");
        assert.equal(item.detection_source, "text");
        assert.equal(item.carving_piece_count, 3);
        assert.equal(item.total_cost, 40);
        assert.equal(item.carving_stag_handle, true);
      });
    });
  });
});

test("startFinderRun does not spend a fresh Gemini call on refresh once a carving set was already vision-rejected for no_case", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|stale|0", run_id: "old-run", keyword_phrases: ["sheffield carving set"],
        title: "Antique Sheffield Carving Set", short_description: "",
        ebay_url: "https://www.ebay.com/itm/stale", image_url: "https://i.ebayimg.com/stale.jpg",
        item_price: 150, shipping_cost: 10, currency: "USD", buying_options: ["FIXED_PRICE"],
        status: "rejected", knife_count: 1, contains_folding_knife: false, confidence: 0.95,
        detection_source: "vision", item_category: "carving_set", reason: "no_case",
        // Stag handle was already confirmed by a prior vision call — this test is about the case
        // requirement specifically, not stag, so stag must not be what re-rejects it here.
        carving_piece_count: 2, carving_has_case: false, carving_carbon_steel: true, carving_stag_handle: true, discovered_at: "2026-01-01",
      }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|stale|0", itemWebUrl: "https://www.ebay.com/itm/stale",
          title: "Antique Sheffield Carving Set",
          price: { value: "1.00", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
        })] }) },
      ], async () => {
        await startFinderRun("manual", "run-carving-stale-no-case");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "must not re-qualify just because the price looks cheap today");
        assert.equal(item.reason, "no_case");
      });
    });
  });
});

test("startFinderRun does not spend a fresh Gemini call on refresh once a carving set was already vision-rejected as stainless steel", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|stale-stainless|0", run_id: "old-run", keyword_phrases: ["sheffield carving set"],
        title: "Antique Sheffield Carving Set", short_description: "",
        ebay_url: "https://www.ebay.com/itm/stale-stainless", image_url: "https://i.ebayimg.com/stale-stainless.jpg",
        item_price: 150, shipping_cost: 10, currency: "USD", buying_options: ["FIXED_PRICE"],
        status: "rejected", knife_count: 1, contains_folding_knife: false, confidence: 0.95,
        detection_source: "vision", item_category: "carving_set", reason: "stainless_steel_vision",
        // A prior vision call confirmed hasCase and stag handle but overturned the text-default
        // material to stainless — carving_carbon_steel: false is what makes that verdict stick.
        carving_piece_count: 2, carving_has_case: true, carving_carbon_steel: false, carving_stag_handle: true, discovered_at: "2026-01-01",
      }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|stale-stainless|0", itemWebUrl: "https://www.ebay.com/itm/stale-stainless",
          title: "Antique Sheffield Carving Set",
          price: { value: "1.00", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
        })] }) },
      ], async () => {
        await startFinderRun("manual", "run-carving-stale-stainless");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "must not re-qualify a confirmed-stainless set just because the price looks cheap today");
        assert.equal(item.reason, "stainless_steel_vision");
      });
    });
  });
});

test("startFinderRun re-rejects a stale German set as not_stag_handle_vision on refresh when a prior vision call never actually confirmed a stag handle (e.g. a row from before this column existed)", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "german carving set", enabled: true, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|stale-no-stag|0", run_id: "old-run", keyword_phrases: ["german carving set"],
        title: "Wertheimer German Knife Fork Cutlery Carving Set", short_description: "",
        ebay_url: "https://www.ebay.com/itm/stale-no-stag", image_url: "https://i.ebayimg.com/stale-no-stag.jpg",
        item_price: 30, shipping_cost: 0, currency: "USD", buying_options: ["FIXED_PRICE"],
        // Case and material were confirmed by a prior vision call (predating the stag-handle
        // requirement), so it currently sits qualified — but carving_stag_handle was never asked
        // about back then, so it's null, not true. A confirmed case/ceiling from a stale row must
        // never be enough on its own to qualify once stag is a hard requirement.
        status: "qualified", knife_count: 1, contains_folding_knife: false, confidence: 0.95,
        detection_source: "vision", item_category: "carving_set", reason: null,
        carving_piece_count: 2, carving_has_case: true, carving_carbon_steel: null, carving_stag_handle: null, discovered_at: "2026-01-01",
      }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|stale-no-stag|0", itemWebUrl: "https://www.ebay.com/itm/stale-no-stag",
          title: "Wertheimer German Knife Fork Cutlery Carving Set",
          price: { value: "30.00", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
        })] }) },
      ], async () => {
        await startFinderRun("manual", "run-carving-stale-no-stag");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "an unconfirmed stag handle must not survive as qualified just because case/ceiling were already known");
        assert.equal(item.reason, "not_stag_handle_vision");
      });
    });
  });
});
