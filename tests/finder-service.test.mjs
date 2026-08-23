import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { dayKey, monthKey } from "../lib/finder-core.ts";
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

test("startFinderRun's scan appends the carving-set modern-origin exclude terms only to carving-set keyword searches, not ordinary pocket-knife ones", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const seenQueries = {};
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "elkington carving set", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "knife lot", enabled: true, created_at: "2026-01-02" },
      ],
    }, async () => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: (url) => {
            const q = new URL(url).searchParams.get("q");
            seenQueries[q.split(" -")[0]] = q;
            return jsonResponse({ itemSummaries: [] });
          },
        },
      ], async () => {
        await startFinderRun("manual", "run-carving-exclude-terms");
        assert.match(seenQueries["elkington carving set"], /-usa -america -american -japan -japanese/, "carving-set keyword searches get the modern-origin exclusions too");
        assert.doesNotMatch(seenQueries["knife lot"], /-usa|-japan/, "ordinary pocket-knife keyword searches must not be widened by the carving-set-only exclusions");
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
          respond: (url) => new URL(url).searchParams.get("q").startsWith("fixed lot")
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

test("startFinderRun sends a summary email covering auctions and fixed-price items in all_qualified mode", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "auction lot", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "fixed lot", enabled: true, created_at: "2026-01-02" },
      ],
      finder_notify_settings: [{ id: true, notify_mode: "all_qualified" }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: (url) => new URL(url).searchParams.get("q").startsWith("fixed lot")
            ? jsonResponse({ itemSummaries: [ebayItem({ itemId: "v1|2|0", itemWebUrl: "https://www.ebay.com/itm/2", title: "Lot of 10 Fixed Price Pocket Knives", buyingOptions: ["FIXED_PRICE"] })] })
            : jsonResponse({ itemSummaries: [ebayItem()] }),
        },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-mixed-summary");
        assert.equal(run.qualified, 2);
        assert.equal(sent.length, 1, "a single summary email covers both items, not one per item");
        assert.match(sent[0].html, /1 auction/);
        assert.match(sent[0].html, /1 fixed-price/);
        assert.doesNotMatch(sent[0].html, /Fixed Price/, "the summary email lists no item details");
        const auctionItem = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|1|0");
        const fixedItem = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|2|0");
        assert.ok(auctionItem.notified_at);
        assert.ok(fixedItem.notified_at, "fixed-price items are stamped notified too, so they aren't recounted next run");
        assert.equal(fixedItem.gixen_status, "not_auction", "Gixen eligibility bookkeeping is unaffected by notify mode");
      });
    });
  });
});

test("startFinderRun prefers DB-configured recipients over FINDER_ALERT_EMAILS", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_notify_recipients: [{ id: "r1", email: "custom@example.test", created_at: "2026-01-01" }],
    }, async () => {
      await withFetch([tokenRoute, { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem()] }) }], async () => {
        await startFinderRun("manual", "run-db-recipients");
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].to, ["custom@example.test"], "DB recipients take priority over FINDER_ALERT_EMAILS once any row exists");
      });
    });
  });
});

test("a subsequent run does not re-send a summary for already-notified items", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_notify_settings: [{ id: true, notify_mode: "all_qualified" }],
    }, async () => {
      await withFetch([tokenRoute, { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem()] }) }, gixenOkRoute], async () => {
        await startFinderRun("manual", "run-summary-first");
        assert.equal(sent.length, 1);
        const second = await startFinderRun("manual", "run-summary-second");
        assert.equal(second.run.qualified, 1, "the item is still qualified on the second scan");
        assert.equal(sent.length, 1, "no additional summary email for an item that was already notified");
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

test("startFinderRun fetches the eBay app token once and reuses it across every keyword search", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    let tokenCalls = 0;
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "pocket knife lot", enabled: true, created_at: "2026-01-02" },
        { id: "k3", phrase: "folding knife lot", enabled: true, created_at: "2026-01-03" },
      ],
    }, async () => {
      await withFetch([
        { test: (url) => url.startsWith(TOKEN_URL), respond: () => { tokenCalls++; return jsonResponse({ access_token: "fake-token" }); } },
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [] }) },
      ], async () => {
        await startFinderRun("manual", "run-shared-token");
        assert.equal(tokenCalls, 1, "one shared token should cover all 3 keyword searches, not one fetch per keyword");
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
          respond: (url) => new URL(url).searchParams.get("q").startsWith("bad keyword") ? textResponse("server error", { status: 500 }) : jsonResponse({ itemSummaries: [ebayItem()] }),
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

test("startFinderRun corrects a stale vision count via the title's own stated lot count, even though text still can't confirm a folding knife on its own", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const title = "LOT OF 15 6inch HANDMADE DAMASCUS STEEL SKINER KNIFE USA Duty paid";
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "damascus skinner knife", enabled: true, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|1|0", run_id: "old-run", keyword_phrases: ["damascus skinner knife"], title, short_description: "",
        ebay_url: "https://www.ebay.com/itm/1", image_url: "https://i.ebayimg.com/1.jpg",
        item_price: 129, shipping_cost: 0, currency: "USD", buying_options: ["FIXED_PRICE"],
        status: "qualified", knife_count: 55, contains_folding_knife: true, confidence: 0.92,
        detection_source: "vision", item_category: "pocket_knife", discovered_at: "2026-01-01",
      }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({
          title, shortDescription: "",
          price: { value: "129.00", currency: "USD" },
          shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
          buyingOptions: ["FIXED_PRICE"],
        })] }) },
      ], async () => {
        await startFinderRun("manual", "run-skinner-knife-fix");
        const [item] = fake.tables.finder_items;
        // The title's own "LOT OF 15" beats the stale vision count of 55, without a new Gemini call
        // (containsFoldingKnife/confidence/category are reused from the previous vision result).
        assert.equal(item.knife_count, 15);
        assert.equal(item.detection_source, "vision");
        assert.equal(item.contains_folding_knife, true);
        assert.equal(item.confidence, 0.92);
        assert.equal(item.cost_per_knife, 129 / 15);
        assert.equal(item.status, "rejected", "$129/15 = $8.60/knife is over the $3.50 default ceiling, unlike the wrongly cheap $129/55");
        assert.equal(item.reason, "over_budget");
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
      await withFetch([imageRoute, geminiRoute({ knifeCount: 10, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "pocket_knife" }), gixenOkRoute], async () => {
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
      await withFetch([imageRoute, geminiRoute({ knifeCount: 8, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "pocket_knife" }), gixenOkRoute], async () => {
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

test("processPendingFinderItems trusts the title's own stated lot count over vision's count on a fixed-blade listing with no folding/brand signal", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null,
        title: "LOT OF 20 8\" HANDMADE DAMASCUS STEEL HUNTING SKINER KNIFE (USA tariff Free)", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 149, shipping_cost: 35, buying_options: ["FIXED_PRICE"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      // Gemini miscounts the seller's whole catalog photo as 120 knives; the title's "LOT OF 20" should win.
      await withFetch([imageRoute, geminiRoute({ knifeCount: 120, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "pocket_knife" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.knife_count, 20);
        assert.equal(item.contains_folding_knife, true);
        assert.equal(item.confidence, 0.95);
        assert.equal(item.cost_per_knife, (149 + 35) / 20);
        assert.equal(item.status, "rejected", "$9.20/knife is over budget, unlike the wrongly cheap $1.53/knife from vision's count of 120");
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
      await withFetch([imageRoute, geminiRoute({ knifeCount: 500, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "pocket_knife" })], async () => {
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

test("processPendingFinderItems rejects a vision-classified garbage category regardless of a cheap price", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Folding Box Cutter", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 1, shipping_cost: 0, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 1, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "box_cutter" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "a box cutter must never qualify, no matter how cheap");
        assert.equal(item.reason, "box_cutter");
        assert.equal(item.item_category, "box_cutter");
      });
    });
  });
});

test("processPendingFinderItems rejects a vision-classified throwing knife regardless of a cheap price", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Balanced Knife Set", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 1, shipping_cost: 0, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 1, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "throwing_knife" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "a throwing knife must never qualify, no matter how cheap");
        assert.equal(item.reason, "throwing_knife");
        assert.equal(item.item_category, "throwing_knife");
      });
    });
  });
});

test("processPendingFinderItems rejects a vision-classified keychain knife regardless of a cheap price", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Small Novelty Knife", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 1, shipping_cost: 0, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 1, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "keychain_knife" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "a keychain knife must never qualify, no matter how cheap");
        assert.equal(item.reason, "keychain_knife");
        assert.equal(item.item_category, "keychain_knife");
      });
    });
  });
});

test("processPendingFinderItems rejects a vision-classified flatware/table-cutlery set regardless of a cheap price", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Mixed Lot of 10 pcs Oneida Silver Carlton Stainless Knife Forks Spoons", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 20, shipping_cost: 5, buying_options: ["FIXED_PRICE"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      // Regression: this reproduces the real production misfire — Gemini reporting
      // containsFoldingKnife: true for a dinner-flatware lot, with itemCategory "other" (which
      // isn't a garbage category) and the whole place-setting piece count counted as knifeCount.
      // That combination used to qualify at $2.50/"knife". table_cutlery now catches it outright.
      await withFetch([imageRoute, geminiRoute({ knifeCount: 10, containsFoldingKnife: true, confidence: 1, uncertaintyReason: "", itemCategory: "table_cutlery" })], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "a flatware/table-cutlery set must never qualify, no matter how cheap");
        assert.equal(item.reason, "table_cutlery");
        assert.equal(item.item_category, "table_cutlery");
      });
    });
  });
});

test("a vision-classified Swiss Army multi-tool qualifies under the stricter $1/knife cap but not merely under the normal $3.50 cap", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [
        { ebay_item_id: "v1|cheap|0", run_id: null, title: "Victorinox Swiss Army Knife Lot", short_description: "", image_url: "https://i.ebayimg.com/1.jpg", item_price: 9, shipping_cost: 0, buying_options: ["AUCTION"], status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt },
        { ebay_item_id: "v1|pricey|0", run_id: null, title: "Victorinox Swiss Army Knife Lot", short_description: "", image_url: "https://i.ebayimg.com/2.jpg", item_price: 15, shipping_cost: 0, buying_options: ["AUCTION"], status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt },
      ],
    }, async (fake) => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 10, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "swiss_army_multi_tool" })], async () => {
        await processPendingFinderItems(5);
        const cheap = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|cheap|0");
        assert.equal(cheap.status, "qualified");
        assert.equal(cheap.cost_per_knife, 0.9);
        const pricey = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|pricey|0");
        assert.equal(pricey.status, "rejected", "$1.50/knife is well under the normal $3.50 cap but over the $1 Swiss Army cap");
        assert.equal(pricey.reason, "over_budget");
        assert.equal(pricey.cost_per_knife, 1.5);
      });
    });
  });
});

test("processPendingFinderItems applies the stricter Swiss Army cap on the fast shipping-only text path too", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Victorinox Swiss Army Knife Lot", short_description: "",
        knife_count: 10, detection_source: "text", contains_folding_knife: true, confidence: 0.99,
        item_category: "swiss_army_multi_tool", item_price: 12, shipping_cost: null, buying_options: ["AUCTION"],
        status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt,
      }],
    }, async (fake) => {
      await withFetch([tokenRoute, itemShippingRoute(3), gixenOkRoute], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 1);
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "$1.50/knife is under the normal $3.50 cap but over the $1 Swiss Army cap");
        assert.equal(item.reason, "over_budget");
        assert.equal(item.cost_per_knife, 1.5);
      });
    });
  });
});

test("startFinderRun keeps a previously vision-rejected garbage category rejected on refresh, without spending a new Gemini call", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "tsa confiscated knives", enabled: true, created_at: "2026-01-01" }],
      finder_items: [{
        ebay_item_id: "v1|1|0", run_id: "old-run", keyword_phrases: ["tsa confiscated knives"],
        title: "TSA confiscated knives assorted lot", short_description: "",
        ebay_url: "https://www.ebay.com/itm/1", image_url: "https://i.ebayimg.com/1.jpg",
        item_price: 20, shipping_cost: 5, currency: "USD", buying_options: ["AUCTION"],
        status: "rejected", knife_count: 5, contains_folding_knife: true, confidence: 0.95,
        detection_source: "vision", item_category: "box_cutter", reason: "box_cutter", discovered_at: "2026-01-01",
      }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({
          title: "TSA confiscated knives assorted lot", shortDescription: "",
          price: { value: "1.00", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
        })] }) },
      ], async () => {
        await startFinderRun("manual", "run-garbage-stays-rejected");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "rejected", "a garbage-categorized vision item must not re-qualify just because the price looks cheap today");
        assert.equal(item.reason, "box_cutter");
        assert.equal(item.item_category, "box_cutter");
      });
    });
  });
});

test("a VisionBudgetError defers the item without bumping attempts, and short-circuits remaining vision attempts in the batch without wasting another Gemini call", async (t) => {
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
        assert.equal(deferred, 2, "both items should be deferred — the second short-circuited rather than actually re-hitting Gemini");
        const first = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|1|0");
        assert.equal(first.attempts, 0, "attempts must not increment on a budget defer");
        assert.equal(first.status, "pending");
        assert.ok(new Date(first.next_attempt_at).getTime() > Date.now() + 55 * 60 * 1000);
        const second = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|2|0");
        assert.equal(second.attempts, 0, "attempts must not increment on the short-circuited defer either");
        assert.ok(new Date(second.next_attempt_at).getTime() > Date.now() + 55 * 60 * 1000, "the second item should also be deferred an hour, without ever calling Gemini again");
      });
    } finally {
      supabaseAdmin.from = restoreFrom;
      supabaseAdmin.rpc = restoreRpc;
    }
  });
});

test("a Gemini quota/budget exhaustion does not block a shipping-only lookup queued later in the same batch", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [
        { ebay_item_id: "v1|1|0", run_id: null, title: "Mixed pocket knife lot", short_description: "", image_url: "https://i.ebayimg.com/1.jpg", item_price: 20, shipping_cost: null, buying_options: ["AUCTION"], status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt },
        { ebay_item_id: "v1|2|0", run_id: null, title: "Lot of 10 Pocket Knives", short_description: "", knife_count: 10, detection_source: "text", contains_folding_knife: true, confidence: 0.99, item_price: 20, shipping_cost: null, buying_options: ["AUCTION"], status: "pending", attempts: 0, next_attempt_at: new Date(Date.now() - 30_000).toISOString(), discovered_at: new Date(Date.now() - 30_000).toISOString() },
      ],
    }, async (fake) => {
      fake.setRpc("reserve_finder_vision_usage", () => ({ data: { reserved: false }, error: null }));
      await withFetch([tokenRoute, itemShippingRoute(5), gixenOkRoute], async () => {
        const { processed, deferred } = await processPendingFinderItems(5);
        assert.equal(processed, 1, "the shipping-only item should still be processed despite Gemini being exhausted");
        assert.equal(deferred, 1);
        const visionItem = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|1|0");
        assert.equal(visionItem.status, "pending");
        assert.equal(visionItem.attempts, 0);
        const shippingOnlyItem = fake.tables.finder_items.find((row) => row.ebay_item_id === "v1|2|0");
        assert.equal(shippingOnlyItem.status, "qualified", "unaffected by the unrelated vision quota exhaustion");
        assert.equal(shippingOnlyItem.cost_per_knife, 2.5);
      });
    });
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

test("processPendingFinderItems reuses one eBay app token across multiple shipping lookups in the same batch", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    let tokenCalls = 0;
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [
        { ebay_item_id: "v1|1|0", run_id: null, title: "Lot of 10 Pocket Knives", short_description: "", knife_count: 10, detection_source: "text", contains_folding_knife: true, confidence: 0.99, item_price: 20, shipping_cost: null, buying_options: ["AUCTION"], status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt },
        { ebay_item_id: "v1|2|0", run_id: null, title: "Lot of 8 Pocket Knives", short_description: "", knife_count: 8, detection_source: "text", contains_folding_knife: true, confidence: 0.99, item_price: 15, shipping_cost: null, buying_options: ["AUCTION"], status: "pending", attempts: 0, next_attempt_at: pastAttempt, discovered_at: pastAttempt },
      ],
    }, async () => {
      await withFetch([
        { test: (url) => url.startsWith(TOKEN_URL), respond: () => { tokenCalls++; return jsonResponse({ access_token: "fake-token" }); } },
        itemShippingRoute(5),
        gixenOkRoute,
      ], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 2);
        assert.equal(tokenCalls, 1, "one shared token should cover both shipping lookups, not one fetch per item");
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
      await withFetch([tokenRoute, imageRoute, geminiRoute({ knifeCount: 8, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "pocket_knife" }), itemShippingRoute(5), gixenOkRoute], async () => {
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
      await withFetch([imageRoute, geminiRoute({ knifeCount: 8, containsFoldingKnife: true, confidence: 0.95, uncertaintyReason: "", itemCategory: "pocket_knife" })], async () => {
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
      assert.equal(offHour.runs.pocket_knife, undefined);
      assert.equal(offHour.runs.carving_set, undefined);
      assert.deepEqual(offHour.queue, { processed: 0, deferred: 0 });

      const onHour = await finderTick(new Date("2026-08-06T10:30:00Z"));
      assert.ok(onHour.runs.pocket_knife);
      assert.equal(onHour.runs.pocket_knife.created, true);
      assert.ok(onHour.runs.carving_set);
      assert.equal(onHour.runs.carving_set.created, true, "both finders share the same default schedule until staff configure their own");
    });
  });
});

test("finderTick fires each finder's automatic scan independently based on its own schedule", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [],
      finder_schedule_settings: [
        { category: "pocket_knife", enabled: true, frequency: "daily", run_hour: 6, run_minute: 0, day_of_week: null },
        { category: "carving_set", enabled: false, frequency: "daily", run_hour: 6, run_minute: 0, day_of_week: null },
      ],
    }, async () => {
      const result = await finderTick(new Date("2026-08-06T10:30:00Z"));
      assert.ok(result.runs.pocket_knife, "pocket-knife finder is enabled and due, so it should fire");
      assert.equal(result.runs.carving_set, undefined, "carving-set finder is disabled, so it must not fire even though the time matches");
    });
  });
});

test("finderTick honors a weekly schedule, only firing on the configured day of week", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [],
      finder_schedule_settings: [
        { category: "pocket_knife", enabled: true, frequency: "weekly", run_hour: 6, run_minute: 0, day_of_week: 4 },
        { category: "carving_set", enabled: true, frequency: "weekly", run_hour: 6, run_minute: 0, day_of_week: 3 },
      ],
    }, async () => {
      // 2026-08-06T10:30:00Z is Thursday 06:30 America/New_York.
      const result = await finderTick(new Date("2026-08-06T10:30:00Z"));
      assert.ok(result.runs.pocket_knife, "Thursday matches the pocket-knife finder's configured weekday");
      assert.equal(result.runs.carving_set, undefined, "Thursday does not match the carving-set finder's configured Wednesday");
    });
  });
});

const FINDER_MONTHLY_LIMIT = 10_000;
const FINDER_DAILY_LIMIT = Math.ceil(FINDER_MONTHLY_LIMIT / 30);

test("finderOverview reports counts, results, and the vision budget", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const month = monthKey();
    const day = dayKey();
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
      finder_vision_usage: [{ month, free_analyses: 30, paid_analyses: 100 }],
      finder_vision_usage_daily: [{ day, analyses: 12 }],
    }, async () => {
      const overview = await finderOverview();
      assert.equal(overview.keywords.length, 2);
      assert.equal(overview.results.length, 2, "only qualified, non-dismissed items are shown");
      assert.equal(overview.runs.length, 1);
      assert.deepEqual(overview.counts, { pending: 2, rejected: 2, qualified: 2 });
      assert.equal(overview.budget.mode, "free");
      assert.equal(overview.budget.freeAnalyses, 30);
      assert.equal(overview.budget.paidAnalyses, 100);
      assert.equal(overview.budget.analyses, 130, "the shared monthly cap counts free + paid analyses together");
      assert.equal(overview.budget.remaining, FINDER_MONTHLY_LIMIT - 130);
      assert.equal(overview.budget.dailyAnalyses, 12);
      assert.equal(overview.budget.dailyLimit, FINDER_DAILY_LIMIT, "defaults to the monthly limit spread evenly across 30 days");
      assert.equal(overview.budget.dailyRemaining, FINDER_DAILY_LIMIT - 12);
      assert.equal(overview.settings.maxCostPerKnife, 3.5);
      assert.deepEqual(overview.notify, { mode: "auctions_only", recipients: [], usingEnvFallback: true, lastAttemptAt: null, lastError: null, lastSuccessAt: null });
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

test("startFinderRun returns the already-active run instead of starting a duplicate scan", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    let searchCalls = 0;
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_runs: [{ id: "active-run", run_key: "manual:already-active", trigger: "manual", status: "running", started_at: new Date().toISOString() }],
    }, async () => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => { searchCalls++; return jsonResponse({ itemSummaries: [ebayItem()] }); } },
      ], async () => {
        const { run, created } = await startFinderRun("manual");
        assert.equal(created, false);
        assert.equal(run.id, "active-run");
        assert.equal(searchCalls, 0, "a run already in progress should block a new scan rather than duplicating it");
      });
    });
  });
});

test("startFinderRun treats a running run older than the lock window as abandoned and starts a fresh scan", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    let searchCalls = 0;
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_runs: [{ id: "stale-run", run_key: "manual:stale", trigger: "manual", status: "running", started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString() }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => { searchCalls++; return jsonResponse({ itemSummaries: [ebayItem()] }); } },
      ], async () => {
        const { run, created } = await startFinderRun("manual", "run-after-stale");
        assert.equal(created, true);
        assert.notEqual(run.id, "stale-run");
        assert.equal(searchCalls, 1, "a run stuck 'running' well past the lock window should not block a fresh scan");
      });
      const stale = fake.tables.finder_runs.find((row) => row.id === "stale-run");
      assert.equal(stale.status, "failed", "the abandoned row itself should be reconciled, not just ignored");
      assert.ok(stale.completed_at, "a reconciled run needs completed_at set so it stops reading as still in progress");
    });
  });
});

test("finderTick reconciles a run orphaned past the lock window even on an off-hour tick with no new run to start", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_runs: [{ id: "orphaned-run", run_key: "scheduled:2026-08-12", trigger: "scheduled", status: "running", started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }],
    }, async (fake) => {
      const result = await finderTick(new Date("2026-08-06T09:59:00Z"));
      assert.equal(result.runs.pocket_knife, undefined, "an off-hour tick still must not start a new scan");
      assert.equal(result.runs.carving_set, undefined, "an off-hour tick still must not start a new scan");
      const orphaned = fake.tables.finder_runs.find((row) => row.id === "orphaned-run");
      assert.equal(orphaned.status, "failed", "a run stuck 'running' for an hour should be reconciled within a single tick, without waiting for the next daily run or a manual click");
      assert.ok(orphaned.completed_at);
    });
  });
});

test("finderTick does not touch a run that is still genuinely within its lock window", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_runs: [{ id: "fresh-run", run_key: "manual:fresh", trigger: "manual", status: "running", started_at: new Date(Date.now() - 60 * 1000).toISOString() }],
    }, async (fake) => {
      await finderTick(new Date("2026-08-06T09:59:00Z"));
      const fresh = fake.tables.finder_runs.find((row) => row.id === "fresh-run");
      assert.equal(fresh.status, "running", "a run only a minute old is still plausibly in progress and must not be reconciled away");
      assert.equal(fresh.completed_at, undefined);
    });
  });
});

test("startFinderRun completes immediately even when it discovers items still awaiting vision, instead of staying \"running\" until the pending queue drains", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem({
          title: "Assorted pocket knife lot", shortDescription: "",
        })] }) },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-with-pending-vision");
        const [item] = fake.tables.finder_items;
        assert.equal(item.status, "pending", "an ambiguous listing with no resolved count must fall through to the vision queue");
        assert.equal(run.status, "completed", "the run's own scan work is done — it must not wait on the separately-tracked vision queue to drain");
        assert.ok(run.completed_at);
      });
      // Even long after the lock window would have elapsed, this run must stay "completed" and
      // never get swept up by reconcileOrphanedRuns (exercised here via the findActiveRun check
      // that every startFinderRun call makes) — it was never left "running" in the first place,
      // regardless of how long its item still sits pending vision analysis.
      fake.tables.finder_runs.find((row) => row.run_key === "run-with-pending-vision").started_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [] }) },
      ], async () => {
        const { created } = await startFinderRun("manual", "run-after-pending-vision");
        assert.equal(created, true, "the earlier run's still-pending vision item must not be mistaken for an active run blocking a fresh scan");
      });
      const stale = fake.tables.finder_runs.find((row) => row.run_key === "run-with-pending-vision");
      assert.equal(stale.status, "completed", "a run that already completed its scan must never be reconciled to \"failed\" no matter how stale its pending vision item is");
    });
  });
});

test("startFinderRun's concurrent keyword scan collects every keyword's results across multiple concurrency waves", async (t) => {
  await withEnv(ENV, async () => {
    mockMailer(t, []);
    const keywordCount = 8;
    const finder_keywords = Array.from({ length: keywordCount }, (_, i) => ({ id: `k${i}`, phrase: `keyword ${i}`, enabled: true, created_at: `2026-01-01T00:00:0${i}Z` }));
    await withFakeBackend({ finder_keywords }, async (fake) => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: (url) => {
            const index = new URL(url).searchParams.get("q").split(" ")[1];
            return jsonResponse({ itemSummaries: [ebayItem({ itemId: `v1|${index}|0`, itemWebUrl: `https://www.ebay.com/itm/${index}`, title: `Lot of 10 Pocket Knives Batch ${index}` })] });
          },
        },
        gixenOkRoute,
      ], async () => {
        const { run } = await startFinderRun("manual", "run-wide-scan");
        assert.equal(run.status, "completed");
        assert.equal(run.keywords_scanned, keywordCount, "the final tally should count every keyword regardless of the concurrency wave it ran in");
        assert.equal(fake.tables.finder_items.length, keywordCount, "every keyword's distinct item should be captured despite concurrent scanning");
        assert.equal(run.qualified, keywordCount);
      });
    });
  });
});

test("processPendingFinderItems's vision-exhaustion short-circuit still limits repeated RPC calls across concurrency waves", async (t) => {
  await withEnv({ ...ENV, FINDER_PROCESS_CONCURRENCY: "2" }, async () => {
    mockMailer(t, []);
    const rowBase = { run_id: null, title: "Pocket knife lot", short_description: "", image_url: "https://i.ebayimg.com/x.jpg", item_price: 20, shipping_cost: 5, status: "pending", attempts: 0 };
    const finder_items = Array.from({ length: 6 }, (_, i) => ({ ...rowBase, ebay_item_id: `v1|${i}|0`, next_attempt_at: new Date(Date.now() - (60 - i) * 1000).toISOString(), discovered_at: new Date(Date.now() - (60 - i) * 1000).toISOString() }));
    const fake = createFakeSupabase({ finder_items });
    let rpcCalls = 0;
    fake.setRpc("reserve_finder_vision_usage", () => { rpcCalls++; return { data: { reserved: false }, error: null }; });
    const restoreFrom = supabaseAdmin.from;
    const restoreRpc = supabaseAdmin.rpc;
    supabaseAdmin.from = fake.from.bind(fake);
    supabaseAdmin.rpc = fake.rpc.bind(fake);
    try {
      await withFetch([], async () => {
        const { processed, deferred } = await processPendingFinderItems(6);
        assert.equal(processed, 0);
        assert.equal(deferred, 6);
        assert.equal(rpcCalls, 2, "only the first wave (bounded by processConcurrency) should actually hit the reservation RPC; later waves should short-circuit on the in-memory flag");
      });
    } finally {
      supabaseAdmin.from = restoreFrom;
      supabaseAdmin.rpc = restoreRpc;
    }
  });
});

test("processPendingFinderItems processes a full batch concurrently without cross-row interference", async (t) => {
  await withEnv({ ...ENV, FINDER_PROCESS_CONCURRENCY: "5" }, async () => {
    mockMailer(t, []);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    const finder_items = Array.from({ length: 5 }, (_, i) => ({
      ebay_item_id: `v1|${i}|0`, run_id: "run-concurrent", title: `Lot of ${i + 1} Pocket Knives`, short_description: "",
      knife_count: i + 1, detection_source: "text", contains_folding_knife: true, confidence: 0.99,
      item_price: 3 * (i + 1), shipping_cost: null, buying_options: ["AUCTION"], status: "pending", attempts: 0,
      next_attempt_at: pastAttempt, discovered_at: pastAttempt,
    }));
    await withFakeBackend({ finder_items, finder_runs: [{ id: "run-concurrent", run_key: "manual:concurrent-batch", trigger: "manual", status: "running", started_at: pastAttempt }] }, async (fake) => {
      let tokenCalls = 0;
      await withFetch([
        { test: (url) => url.startsWith(TOKEN_URL), respond: () => { tokenCalls++; return jsonResponse({ access_token: "fake-token" }); } },
        itemShippingRoute(0.5),
        gixenOkRoute,
      ], async () => {
        const { processed } = await processPendingFinderItems(5);
        assert.equal(processed, 5, "every independent row in the batch should be processed despite running concurrently");
        assert.equal(tokenCalls, 1, "the shared token cache must still dedupe correctly when every row starts at once");
        for (let i = 0; i < 5; i++) {
          const item = fake.tables.finder_items.find((row) => row.ebay_item_id === `v1|${i}|0`);
          assert.equal(item.shipping_cost, 0.5, `row ${i} must get its own correct shipping cost, not another row's`);
          assert.equal(item.knife_count, i + 1, `row ${i}'s own knife_count must be untouched by other rows processing concurrently`);
        }
        const run = fake.tables.finder_runs.find((row) => row.id === "run-concurrent");
        assert.equal(run.status, "completed", "the run should be recomputed as completed once every one of its items clears the pending queue");
      });
    });
  });
});
