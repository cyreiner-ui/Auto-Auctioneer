import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { monthKey } from "../lib/finder-core.ts";
import { __resetGixenDriver, __setGixenDriver } from "../lib/gixen-client.ts";
import {
  archivedFinderItems,
  finderOverview,
  finderTick,
  processPendingFinderItems,
  startFinderRun,
} from "../lib/finder-service.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, textResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

const ENV = {
  EBAY_CLIENT_ID: "client-id",
  EBAY_CLIENT_SECRET: "client-secret",
  EBAY_ENVIRONMENT: "sandbox",
  EBAY_FINDER_MAX_PER_KNIFE: "3.50",
  GEMINI_API_KEY: "gemini-key",
  GEMINI_CONFIDENCE_THRESHOLD: "0.90",
  GIXEN_USERNAME: "buyer",
  GIXEN_PASSWORD: "secret",
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
const itemShippingRoute = (value) => ({ test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ shippingOptions: value == null ? [] : [{ shippingCost: { value: String(value), currency: "USD" } }] }) });
const gixenOkRoute = { test: (url) => url.includes("gixen.com/api.php"), respond: () => textResponse("OK snipe ADDED") };
const imageRoute = { test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }) };
const geminiRoute = (body) => ({ test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }) });

function ebayItem(overrides = {}) {
  return {
    itemId: "v1|1|0",
    title: "Lot of 10 Smith & Wesson Pocket Knives",
    shortDescription: "",
    itemWebUrl: "https://www.ebay.com/itm/1",
    image: { imageUrl: "https://i.ebayimg.com/1.jpg" },
    price: { value: "30.00", currency: "USD" },
    shippingOptions: [{ shippingCost: { value: "5.00", currency: "USD" } }],
    buyingOptions: ["AUCTION"],
    ...overrides,
  };
}

// Installs the fake Supabase client (shared by finder-service.ts and gemini-vision.ts)
// and a mocked nodemailer transport, running `fn` with both live for the duration.
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

test("startFinderRun qualifies an auction item, emails the alert, but does not auto-send to Gixen", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    let gixenCalled = false;
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem()] }) },
        { test: (url) => url.includes("gixen.com/api.php"), respond: () => { gixenCalled = true; return textResponse("OK snipe ADDED"); } },
      ], async () => {
        const { run, created } = await startFinderRun("manual", "run-1");
        assert.equal(created, true);
        assert.equal(run.status, "completed");
        assert.equal(run.qualified, 1);
        assert.equal(run.rejected, 0);

        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.knife_count, 10);
        assert.equal(item.cost_per_knife, 3.5);
        assert.equal(item.detection_source, "text");
        assert.equal(item.gixen_status, undefined, "qualifying no longer auto-sends to Gixen");
        assert.equal(item.gixen_sent_at, undefined);
        assert.equal(item.max_bid, undefined);
        assert.ok(item.notified_at);
        assert.equal(gixenCalled, false);
        assert.equal(sent.length, 1);
        assert.match(sent[0].html, /Lot of 10 Smith &amp; Wesson Pocket Knives/);
      });
    });
  });
});

test("startFinderRun only emails auction-format items in a mixed qualifying batch", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "auction lot", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "fixed lot", enabled: true, created_at: "2026-01-02" },
      ],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: (url) => new URL(url).searchParams.get("q") === "fixed lot"
            ? jsonResponse({ itemSummaries: [ebayItem({ itemId: "v1|2|0", itemWebUrl: "https://www.ebay.com/itm/2", title: "Lot of 10 Fixed Price Pocket Knives", buyingOptions: ["FIXED_PRICE"] })] })
            : jsonResponse({ itemSummaries: [ebayItem()] }),
        },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-mixed");
        assert.equal(run.qualified, 2);
        assert.equal(sent.length, 1, "only the auction item should trigger an alert email");
        assert.match(sent[0].html, /Lot of 10 Smith &amp; Wesson Pocket Knives/);
        assert.doesNotMatch(sent[0].html, /Fixed Price/);
        const fixedItem = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|2|0");
        assert.equal(fixedItem.gixen_status, "not_auction");
        assert.equal(fixedItem.notified_at, undefined);
      });
    });
  });
});

test("startFinderRun never sends a fixed-price (non-auction) qualifying item to Gixen", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    let gixenCalled = false;
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({ buyingOptions: ["FIXED_PRICE"] })] }) },
        { test: (url) => url.includes("gixen.com/api.php"), respond: () => { gixenCalled = true; return textResponse("OK snipe ADDED"); } },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-fixed-price");
        assert.equal(run.qualified, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.gixen_status, "not_auction");
        assert.equal(item.gixen_sent_at, null);
        assert.equal(gixenCalled, false, "Gixen (which only snipes auctions) should never be called for a fixed-price listing");
      });
    });
  });
});

test("startFinderRun does not auto-send to Gixen even when GIXEN_AUTOMATION_MODE=browser", async (t) => {
  await withEnv({ ...ENV, GIXEN_AUTOMATION_MODE: "browser" }, async () => {
    mockMailer(t, []);
    let addSnipeCalls = 0;
    const driver = {
      async launch() { return { page: {} }; },
      async login() {},
      async submitAddSnipe(page, params) { addSnipeCalls += 1; return { ok: true, message: `added ${params.itemId}` }; },
      async submitDeleteSnipe() { return { ok: true, message: "n/a" }; },
    };
    __setGixenDriver(driver);
    try {
      await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
        await withFetch([
          tokenRoute,
          { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem()] }) },
        ], async () => {
          const { run } = await startFinderRun("manual", "browser-run-1");
          assert.equal(run.qualified, 1);
          const [item] = fake.tables.finder_items;
          assert.equal(item.gixen_status, undefined);
          assert.equal(item.gixen_sent_at, undefined);
          assert.equal(addSnipeCalls, 0);
        });
      });
    } finally {
      __resetGixenDriver();
    }
  });
});

test("startFinderRun is idempotent for the same run key", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    let searchCalls = 0;
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async () => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => { searchCalls++; return jsonResponse({ itemSummaries: [ebayItem()] }); } },
        gixenOkRoute,
      ], async () => {
        await startFinderRun("manual", "same-key");
        assert.equal(searchCalls, 1);
        const second = await startFinderRun("manual", "same-key");
        assert.equal(second.created, false);
        assert.equal(searchCalls, 1, "the second call must not re-run the eBay search");
      });
    });
  });
});

test("a failing keyword search is captured in the run's errors without aborting the run", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "bad keyword", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "knife lot", enabled: true, created_at: "2026-01-02" },
      ],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: (url) => new URL(url).searchParams.get("q") === "bad keyword" ? textResponse("server error", { status: 500 }) : jsonResponse({ itemSummaries: [ebayItem()] }),
        },
        gixenOkRoute,
      ], async () => {
        const { run } = await startFinderRun("manual", "run-with-error");
        assert.equal(run.status, "completed");
        assert.equal(run.keywords_scanned, 2);
        assert.equal(fake.tables.finder_items.length, 1);
        assert.ok(run.errors.some((message) => /bad keyword/.test(message)));
      });
    });
  });
});

test("startFinderRun discards a stale vision count once the (now-fixed) text parser resolves the listing on its own", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const title = "New Folding Knife Lot Fox Edge Smith & Wesson Camillus 3-Piece Bundle NIB";
    const description = "Fox Edge Mandatory Fun FE-024 folding knife with an 8Cr13MoV stainless steel blade and ball bearing pivot.";
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|1|0", run_id: "old-run", keyword_phrases: ["knife lot"], title, short_description: description,
        ebay_url: "https://www.ebay.com/itm/1", image_url: "https://i.ebayimg.com/1.jpg",
        item_price: 20, shipping_cost: 5, currency: "USD", buying_options: ["AUCTION"],
        status: "qualified", knife_count: 24, contains_folding_knife: true, confidence: 0.7,
        detection_source: "vision", discovered_at: "2026-01-01",
      }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({
          title, shortDescription: description,
          price: { value: "20.00", currency: "USD" },
          shippingOptions: [{ shippingCost: { value: "5.00", currency: "USD" } }],
        })] }) },
      ], async () => {
        await startFinderRun("manual", "run-stale-vision-fix");
        const [item] = fake.tables.finder_items;
        assert.equal(item.detection_source, "text");
        assert.equal(item.knife_count, 3);
        assert.equal(item.status, "rejected", "the true count of 3 puts this over budget even though the stale count of 24 wrongly qualified it");
        assert.equal(item.reason, "over_budget");
      });
    });
  });
});

test("startFinderRun still preserves a vision count when the current text parser is still ambiguous", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "tsa confiscated knives", enabled: true, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|1|0", run_id: "old-run", keyword_phrases: ["tsa confiscated knives"],
        title: "TSA confiscated knives assorted lot", short_description: "",
        ebay_url: "https://www.ebay.com/itm/1", image_url: "https://i.ebayimg.com/1.jpg",
        item_price: 20, shipping_cost: 5, currency: "USD", buying_options: ["AUCTION"],
        status: "qualified", knife_count: 6, contains_folding_knife: true, confidence: 0.8,
        detection_source: "vision", discovered_at: "2026-01-01",
      }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({
          title: "TSA confiscated knives assorted lot", shortDescription: "",
          price: { value: "20.00", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "5.00", currency: "USD" } }],
        })] }) },
      ], async () => {
        await startFinderRun("manual", "run-still-ambiguous");
        const [item] = fake.tables.finder_items;
        assert.equal(item.detection_source, "vision");
        assert.equal(item.knife_count, 6);
      });
    });
  });
});

test("startFinderRun applies a keyword's per-knife price override instead of the global default", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "spyderco knife lot", enabled: true, max_cost_per_knife: 8, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({
          title: "Lot of 10 Spyderco Pocket Knives",
          price: { value: "60.00", currency: "USD" },
          shippingOptions: [{ shippingCost: { value: "5.00", currency: "USD" } }],
        })] }) },
        gixenOkRoute,
      ], async () => {
        const { run } = await startFinderRun("manual", "run-brand-override");
        assert.equal(run.qualified, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.knife_count, 10);
        assert.equal(item.cost_per_knife, 6.5);
        assert.equal(item.status, "qualified", "the $8 spyderco override, not the $3.50 global default, should apply");
      });
    });
  });
});

test("startFinderRun takes the highest override when an item matches multiple keywords with different ceilings", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "spyderco knife lot", enabled: true, max_cost_per_knife: 8, created_at: "2026-01-01" },
        { id: "k2", phrase: "knife lot", enabled: true, max_cost_per_knife: null, created_at: "2026-01-02" },
      ],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({
          title: "Lot of 10 Spyderco Pocket Knives",
          price: { value: "60.00", currency: "USD" },
          shippingOptions: [{ shippingCost: { value: "5.00", currency: "USD" } }],
        })] }) },
        gixenOkRoute,
      ], async () => {
        const { run } = await startFinderRun("manual", "run-multi-keyword-override");
        assert.equal(run.qualified, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified", "the higher $8 override should win over the unset generic keyword match");
      });
    });
  });
});

test("processPendingFinderItems resolves a pending item's ceiling using its matched keyword's override", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "spyderco knife lot", enabled: true, max_cost_per_knife: 8, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Mixed spyderco knife lot", short_description: "",
        keyword_phrases: ["spyderco knife lot"],
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 60, shipping_cost: 5, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 10, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "" }), gixenOkRoute], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified", "the $8 override should apply to a vision-resolved pending item too");
        assert.equal(item.cost_per_knife, 6.5);
      });
    });
  });
});

test("processPendingFinderItems resolves a pending item through vision and notifies", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Mixed pocket knife lot", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 20, shipping_cost: 5, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 8, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "" }), gixenOkRoute], async () => {
        const { processed, deferred } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        assert.equal(deferred, 0);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.detection_source, "vision");
        assert.equal(item.knife_count, 8);
        assert.equal(item.cost_per_knife, 3.125);
        assert.equal(item.attempts, 1);
        assert.equal(item.next_attempt_at, null);
        assert.equal(item.gixen_status, undefined, "qualifying via vision no longer auto-sends to Gixen either");
        assert.ok(item.notified_at);
        assert.equal(sent.length, 1);
      });
    });
  });
});

test("processPendingFinderItems rejects an implausibly large vision-reported knife count as a sanity guard", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Mixed pocket knife lot", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 20, shipping_cost: 5, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 500, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "implausible_count");
        assert.equal(item.detection_source, "vision");
      });
    });
  });
});

test("a VisionBudgetError defers the item without bumping attempts and stops the batch", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    const rowBase = { run_id: null, title: "Pocket knife lot", short_description: "", image_url: "https://i.ebayimg.com/x.jpg", item_price: 20, shipping_cost: 5, status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt };
    const fake = createFakeSupabase({ finder_items: [{ ...rowBase, ebay_item_id: "v1|1|0" }, { ...rowBase, ebay_item_id: "v1|2|0", discovered_at: new Date(Date.now() - 30_000).toISOString() }] });
    fake.setRpc("reserve_finder_vision_usage", () => ({ data: { reserved: false }, error: null }));
    const restoreFrom = supabaseAdmin.from;
    const restoreRpc = supabaseAdmin.rpc;
    supabaseAdmin.from = fake.from.bind(fake);
    supabaseAdmin.rpc = fake.rpc.bind(fake);
    try {
      await withFetch([], async () => {
        const { processed, deferred } = await processPendingFinderItems(5);
        assert.equal(processed, 0);
        assert.equal(deferred, 1);
        const first = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|1|0");
        assert.equal(first.attempts, 0, "attempts must not increment on a budget defer");
        assert.equal(first.status, "pending");
        assert.ok(new Date(first.next_attempt_at).getTime() > Date.now() + 55 * 60 * 1000);
        const second = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|2|0");
        assert.equal(second.next_attempt_at, pastAttempt, "the second item must not be touched once the batch stops");
      });
    } finally {
      supabaseAdmin.from = restoreFrom;
      supabaseAdmin.rpc = restoreRpc;
    }
  });
});

test("a generic analysis error bumps attempts and errors out at the third try", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|1|0", run_id: null, title: "Pocket knife lot", short_description: "",
        image_url: "https://i.ebayimg.com/x.jpg", item_price: 20, shipping_cost: 5,
        status: "pending", attempts: 2, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, { test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => textResponse("server error", { status: 500 }) }], async () => {
        const { processed, deferred } = await processPendingFinderItems(5);
        assert.equal(processed, 0);
        assert.equal(deferred, 0);
        const [item] = fake.tables.finder_items;
        assert.equal(item.attempts, 3);
        assert.equal(item.status, "error");
        assert.equal(item.next_attempt_at, null);
        assert.match(item.reason, /Gemini analysis failed \(500\)/);
      });
    });
  });
});

test("a generic analysis error under the retry limit stays pending for a later retry", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|1|0", run_id: null, title: "Pocket knife lot", short_description: "",
        image_url: "https://i.ebayimg.com/x.jpg", item_price: 20, shipping_cost: 5,
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, { test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => textResponse("server error", { status: 500 }) }], async () => {
        await processPendingFinderItems(5);
        const [item] = fake.tables.finder_items;
        assert.equal(item.attempts, 1);
        assert.equal(item.status, "pending");
        assert.ok(item.next_attempt_at);
      });
    });
  });
});

test("startFinderRun defers a text-resolved but shipping-missing listing to a follow-up lookup, then qualifies once shipping is found", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({ price: { value: "20.00", currency: "USD" }, shippingOptions: [] })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-shipping-pending");
        assert.equal(run.qualified, 0);
        const [pendingItem] = fake.tables.finder_items;
        assert.equal(pendingItem.status, "pending");
        assert.equal(pendingItem.knife_count, 10);
        assert.equal(pendingItem.detection_source, "text");
        assert.equal(pendingItem.shipping_cost, null);
      });
      fake.tables.finder_items[0].next_attempt_at = new Date(Date.now() - 60_000).toISOString();
      await withFetch([tokenRoute, itemShippingRoute(5), gixenOkRoute], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.shipping_cost, 5);
        assert.equal(item.shipping_source, "lookup");
        assert.equal(item.cost_per_knife, 2.5);
      });
    });
  });
});

test("startFinderRun rejects immediately as over_budget without a shipping lookup when the price alone already exceeds the ceiling", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({ price: { value: "100.00", currency: "USD" }, shippingOptions: [] })] }) },
      ], async () => {
        await startFinderRun("manual", "run-over-budget-no-lookup");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "over_budget");
        assert.equal(item.shipping_cost, null);
      });
    });
  });
});

test("processPendingFinderItems looks up shipping after vision resolves the count, when worthwhile", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Mixed pocket knife lot", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 20, shipping_cost: null, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([tokenRoute, imageRoute, geminiRoute({ knifeCount: 8, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "" }), itemShippingRoute(5), gixenOkRoute], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "qualified");
        assert.equal(item.knife_count, 8);
        assert.equal(item.shipping_cost, 5);
        assert.equal(item.shipping_source, "lookup");
        assert.equal(item.cost_per_knife, 3.125);
      });
    });
  });
});

test("processPendingFinderItems skips the shipping lookup and rejects immediately when the vision-resolved price alone is already over budget", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Mixed pocket knife lot", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 100, shipping_cost: null, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 8, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected");
        assert.equal(item.reason, "over_budget");
        assert.equal(item.shipping_cost, null);
      });
    });
  });
});

test("startFinderRun preserves a previously looked-up shipping cost when eBay's search result is still missing one", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|1|0", run_id: "old-run", keyword_phrases: ["knife lot"],
        title: "Lot of 10 Smith & Wesson Pocket Knives", short_description: "",
        ebay_url: "https://www.ebay.com/itm/1", image_url: "https://i.ebayimg.com/1.jpg",
        item_price: 20, shipping_cost: 5, shipping_source: "lookup", currency: "USD", buying_options: ["AUCTION"],
        status: "qualified", knife_count: 10, contains_folding_knife: true, confidence: 0.99,
        detection_source: "text", discovered_at: "2026-01-01",
      }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({ price: { value: "20.00", currency: "USD" }, shippingOptions: [] })] }) },
        gixenOkRoute,
      ], async () => {
        await startFinderRun("manual", "run-preserve-lookup-shipping");
        const [item] = fake.tables.finder_items;
        assert.equal(item.shipping_cost, 5, "the previously looked-up shipping cost should carry forward instead of resetting to null");
        assert.equal(item.shipping_source, "lookup");
        assert.equal(item.status, "qualified");
        assert.equal(item.cost_per_knife, 2.5);
      });
    });
  });
});

test("finderTick only starts a search on the daily hour, but always drains the pending queue", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({ finder_keywords: [] }, async () => {
      const offHour = await finderTick(new Date("2026-08-06T09:59:00Z"));
      assert.equal(offHour.dailyRun, null);
      assert.deepEqual(offHour.queue, { processed: 0, deferred: 0 });

      const onHour = await finderTick(new Date("2026-08-06T10:30:00Z"));
      assert.ok(onHour.dailyRun);
      assert.equal(onHour.dailyRun.created, true);
    });
  });
});

const FINDER_MONTHLY_LIMIT = 50_000;

test("finderOverview reports counts, results, and the vision budget", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const month = monthKey();
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "a", enabled: true, created_at: "2026-01-01" }, { id: "k2", phrase: "b", enabled: true, created_at: "2026-01-02" }],
      finder_items: [
        { ebay_item_id: "1", status: "qualified", dismissed_at: null, discovered_at: "2026-01-03" },
        { ebay_item_id: "2", status: "qualified", dismissed_at: null, discovered_at: "2026-01-02" },
        { ebay_item_id: "3", status: "qualified", dismissed_at: "2026-01-04", discovered_at: "2026-01-01" },
        { ebay_item_id: "4", status: "pending", dismissed_at: null, discovered_at: "2026-01-01" },
        { ebay_item_id: "5", status: "pending", dismissed_at: null, discovered_at: "2026-01-01" },
        { ebay_item_id: "6", status: "rejected", dismissed_at: null, discovered_at: "2026-01-01" },
        { ebay_item_id: "7", status: "error", dismissed_at: null, discovered_at: "2026-01-01" },
      ],
      finder_runs: [{ id: "r1", started_at: "2026-01-01" }],
      finder_vision_usage: [{ month, paid_analyses: 100 }],
    }, async () => {
      const overview = await finderOverview();
      assert.equal(overview.keywords.length, 2);
      assert.equal(overview.results.length, 2, "only qualified, non-dismissed items are shown");
      assert.equal(overview.runs.length, 1);
      assert.deepEqual(overview.counts, { pending: 2, rejected: 2, qualified: 2 });
      assert.equal(overview.budget.mode, "free");
      assert.equal(overview.budget.paidAnalyses, 100);
      assert.equal(overview.budget.remaining, FINDER_MONTHLY_LIMIT - 100);
      assert.equal(overview.settings.maxCostPerKnife, 3.5);
    });
  });
});

test("archivedFinderItems returns only dismissed qualified items, newest first", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_items: [
        { ebay_item_id: "1", status: "qualified", dismissed_at: "2026-01-01" },
        { ebay_item_id: "2", status: "qualified", dismissed_at: "2026-01-05" },
        { ebay_item_id: "3", status: "qualified", dismissed_at: null },
        { ebay_item_id: "4", status: "rejected", dismissed_at: "2026-01-06" },
      ],
    }, async () => {
      const { results } = await archivedFinderItems();
      assert.deepEqual(results.map((row) => row.ebay_item_id), ["2", "1"]);
    });
  });
});

test("a failed email send does not stamp notified_at, so it retries next tick", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async () => { throw new Error("smtp down"); } }));
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([tokenRoute, { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem()] }) }, gixenOkRoute], async () => {
        await startFinderRun("manual", "run-email-fail");
        const [item] = fake.tables.finder_items;
        assert.equal(item.notified_at, undefined);
        assert.equal(item.gixen_status, undefined, "Gixen sending is unaffected either way, since it no longer happens automatically at qualification time");
      });
    });
    assert.equal(sent.length, 0);
  });
});
