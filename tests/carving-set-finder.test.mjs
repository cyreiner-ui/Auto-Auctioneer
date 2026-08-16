import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { analyzeCarvingSetText, carvingSetCeiling } from "../lib/carving-set-finder.ts";
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

test("analyzeCarvingSetText flags carving-set phrasing", () => {
  assert.equal(analyzeCarvingSetText("Sheffield Carving Set").isCarvingSet, true);
  assert.equal(analyzeCarvingSetText("Sheffield Carving Knife and Fork Set").isCarvingSet, true);
  assert.equal(analyzeCarvingSetText("Sheffield Pocket Knife Lot").isCarvingSet, false);
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
const tokenRoute = { test: (url) => url.startsWith(TOKEN_URL), respond: () => jsonResponse({ access_token: "fake-token" }) };
const imageRoute = { test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }) };
const geminiRoute = (body) => ({ test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }) });

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

test("startFinderRun qualifies a Sheffield carving set that's carbon steel and cased, under the flat $200 ceiling", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          title: "Antique Sheffield Carving Set, carbon steel blade, with fitted case",
          price: { value: "180.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-sheffield");
        assert.equal(run.qualified, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.item_category, "carving_set");
        assert.equal(item.knife_count, 1);
        assert.equal(item.detection_source, "text");
        assert.equal(item.total_cost, 180);
        assert.equal(item.carving_has_case, true);
        assert.equal(item.carving_carbon_steel, true);
      });
    });
  });
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

test("startFinderRun qualifies a Sheffield carving set that mentions neither carbon steel nor stainless at all", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          title: "Antique Sheffield Carving Set, with fitted case",
          price: { value: "180.00", currency: "USD" },
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-carving-no-material-word");
        assert.equal(run.qualified, 1, "most real listings say neither word, so this must default to qualifying, not require an explicit \"carbon steel\" match");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.carving_carbon_steel, true);
      });
    });
  });
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

test("negative-keyword brands (Crown Crest, Lewis Rose & Co, Landers Frary & Clark, Sherwood, Tramontina, Ekco, Rogers Bros) all reject a Sheffield carving set", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const brands = ["Crown Crest", "Crowncrest", "Lewis Rose & Co", "Lewis Rose and Co.", "Landers, Frary & Clark", "Landers Frary", "Sherwood", "Tramontina", "Ekco", "Rogers Bros", "Wm Rogers"];
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

test("startFinderRun qualifies a German carving set under the tiered $10/piece + $15 ceiling", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "german carving set", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [carvingItem({
          itemId: "v1|german|0", itemWebUrl: "https://www.ebay.com/itm/german",
          title: "Wusthof 3 piece Carving Set, cased",
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
          title: "Wusthof 2 piece Carving Set, cased",
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
      await withFetch([imageRoute, geminiRoute({ hasCase: false, pieceCount: 2, confidence: 0.95, uncertaintyReason: "" })], async () => {
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
      await withFetch([imageRoute, geminiRoute({ hasCase: true, pieceCount: 2, confidence: 0.95, uncertaintyReason: "" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.total_cost, 160);
        assert.equal(item.carving_has_case, true);
        assert.equal(item.carving_carbon_steel, true, "carried forward from the row's already-resolved material, not asked of vision");
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
        carving_piece_count: 2, carving_has_case: false, carving_carbon_steel: true, discovered_at: "2026-01-01",
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
