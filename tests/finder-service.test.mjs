import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { monthKey } from "../lib/finder-core.ts";
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
const tokenRoute = { test: (url) => url.startsWith(TOKEN_URL), respond: () => jsonResponse({ access_token: "fake-token" }) };
const gixenOkRoute = { test: (url) => url.includes("gixen.com/api.php"), respond: () => textResponse("OK snipe ADDED") };
const gixenFailRoute = { test: (url) => url.includes("gixen.com/api.php"), respond: () => textResponse("ERROR (211): item already ended") };
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
    buyingOptions: ["FIXED_PRICE"],
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

test("startFinderRun finds a qualifying item, sends it to Gixen, and emails the alert", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem()] }) },
        gixenOkRoute,
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
        assert.equal(item.gixen_status, "sent");
        assert.ok(item.gixen_sent_at);
        assert.ok(item.notified_at);
        assert.equal(sent.length, 1);
        assert.match(sent[0].html, /Lot of 10 Smith &amp; Wesson Pocket Knives/);
      });
    });
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

test("processPendingFinderItems resolves a pending item through vision and notifies", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    const pastAttempt = new Date(Date.now() - 60_000).toISOString();
    await withFakeBackend({
      finder_items: [{
        ebay_item_id: "v1|9|0", run_id: null, title: "Mixed pocket knife lot", short_description: "",
        image_url: "https://i.ebayimg.com/9.jpg", item_price: 20, shipping_cost: 5,
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
        assert.equal(item.gixen_status, "sent");
        assert.ok(item.notified_at);
        assert.equal(sent.length, 1);
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
        assert.equal(item.gixen_status, "sent", "Gixen still succeeds independently of the email failure");
      });
    });
    assert.equal(sent.length, 0);
  });
});

test("a failed Gixen send does not block the email notification", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({ finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }] }, async (fake) => {
      await withFetch([tokenRoute, { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [ebayItem()] }) }, gixenFailRoute], async () => {
        await startFinderRun("manual", "run-gixen-fail");
        const [item] = fake.tables.finder_items;
        assert.equal(item.gixen_status, "failed");
        assert.match(item.gixen_message, /ERROR/);
        assert.ok(item.notified_at, "email still succeeds independently of the Gixen failure");
        assert.equal(sent.length, 1);
      });
    });
  });
});
