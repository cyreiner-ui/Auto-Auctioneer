import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { PATCH as keywordsPatch } from "../app/api/finder/keywords/route.ts";
import { archivedFinderItems, finderOverview, processPendingFinderItems, startFinderRun } from "../lib/finder-service.ts";
import { COOKIE_NAME, staffSessionToken } from "../lib/staff-auth.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

const STAFF_PASSWORD = "test-staff-password";
const ENV = {
  APP_STAFF_PASSWORD: STAFF_PASSWORD,
  EBAY_CLIENT_ID: "client-id",
  EBAY_CLIENT_SECRET: "client-secret",
  EBAY_ENVIRONMENT: "sandbox",
  EBAY_FINDER_MAX_PER_KNIFE: "3.50",
  GEMINI_API_KEY: "gemini-key",
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
  t.mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message) => { capture.push(message); return { messageId: "test" }; },
  }));
}

test("finderOverview(category) shows each track only its own keywords, results, and counts", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-02" },
        { id: "k3", phrase: "german carving set", enabled: true, created_at: "2026-01-03" },
      ],
      finder_items: [
        { ebay_item_id: "pk1", keyword_phrases: ["knife lot"], status: "qualified", dismissed_at: null, item_price: 10, discovered_at: "2026-01-01" },
        { ebay_item_id: "cs1", keyword_phrases: ["sheffield carving set"], status: "qualified", dismissed_at: null, item_price: 180, discovered_at: "2026-01-01" },
        { ebay_item_id: "cs2", keyword_phrases: ["german carving set"], status: "pending", dismissed_at: null, discovered_at: "2026-01-01" },
        { ebay_item_id: "pk2", keyword_phrases: ["knife lot"], status: "rejected", dismissed_at: null, discovered_at: "2026-01-01" },
      ],
      finder_runs: [],
    }, async () => {
      const pocketOverview = await finderOverview("pocket_knife");
      assert.deepEqual(pocketOverview.keywords.map((k) => k.phrase), ["knife lot"]);
      assert.deepEqual(pocketOverview.results.map((r) => r.ebay_item_id), ["pk1"]);
      assert.deepEqual(pocketOverview.counts, { pending: 0, rejected: 1, qualified: 1 });

      const carvingOverview = await finderOverview("carving_set");
      assert.deepEqual(carvingOverview.keywords.map((k) => k.phrase).sort(), ["german carving set", "sheffield carving set"]);
      assert.deepEqual(carvingOverview.results.map((r) => r.ebay_item_id), ["cs1"]);
      assert.deepEqual(carvingOverview.counts, { pending: 1, rejected: 0, qualified: 1 });
    });
  });
});

test("archivedFinderItems(category) only returns that category's dismissed items", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_items: [
        { ebay_item_id: "pk1", keyword_phrases: ["knife lot"], status: "qualified", dismissed_at: "2026-01-02" },
        { ebay_item_id: "cs1", keyword_phrases: ["sheffield carving set"], status: "qualified", dismissed_at: "2026-01-02" },
      ],
    }, async () => {
      const pocket = await archivedFinderItems("pocket_knife");
      assert.deepEqual(pocket.results.map((r) => r.ebay_item_id), ["pk1"]);
      const carving = await archivedFinderItems("carving_set");
      assert.deepEqual(carving.results.map((r) => r.ebay_item_id), ["cs1"]);
    });
  });
});

test("editing a carving-set keyword via the shared keywords route never touches pocket-knife rows", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "knife lot", enabled: true, max_cost_per_knife: null, created_at: "2026-01-01" },
        { id: "k2", phrase: "sheffield carving set", enabled: true, max_cost_per_knife: null, created_at: "2026-01-02" },
      ],
    }, async (fake) => {
      const before = JSON.stringify(fake.tables.finder_keywords.find((k) => k.id === "k1"));
      const token = staffSessionToken(STAFF_PASSWORD);
      const response = await keywordsPatch(new Request("https://x.test/api/finder/keywords", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: `${COOKIE_NAME}=${token}` },
        body: JSON.stringify({ id: "k2", enabled: false }),
      }));
      assert.equal(response.status, 200, "the edit must actually succeed for this isolation check to mean anything");
      assert.equal(fake.tables.finder_keywords.find((k) => k.id === "k2").enabled, false);
      const after = JSON.stringify(fake.tables.finder_keywords.find((k) => k.id === "k1"));
      assert.equal(before, after, "the pocket-knife keyword row must be byte-for-byte unchanged");
    });
  });
});

test("startFinderRun(category) only scans that category's enabled keywords", async () => {
  await withEnv(ENV, async () => {
    const searchedPhrases = [];
    const categoryBrowses = [];
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-02" },
        { id: "k3", phrase: "german carving set", enabled: true, created_at: "2026-01-03" },
      ],
    }, async () => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: (url) => {
            const params = new URL(url).searchParams;
            const categoryIds = params.get("category_ids");
            if (categoryIds) categoryBrowses.push(categoryIds);
            else searchedPhrases.push(params.get("q"));
            return jsonResponse({ itemSummaries: [] });
          },
        },
      ], async () => {
        await startFinderRun("manual", "run-carving-only", "carving_set");
        // searchEbayKeyword appends exclusion terms (see FINDER_DEFAULTS.excludeTerms) to every
        // query, so match on the keyword being searched, not the exact resulting query string.
        assert.equal(searchedPhrases.length, 2);
        assert.ok(searchedPhrases.every((phrase) => phrase.startsWith("sheffield carving set") || phrase.startsWith("german carving set")), "a carving-set-scoped run must never search the pocket-knife keyword");
        // A carving-set-scoped run also browses the "Flatware Sets" category directly (see
        // CARVING_SET_CATEGORY_ID) — a separate lead source alongside the phrase searches above,
        // not gated by any finder_keywords row.
        assert.deepEqual(categoryBrowses, ["131608"]);
      });
    });
    searchedPhrases.length = 0;
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-02" },
      ],
    }, async () => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(SEARCH_URL), respond: (url) => { searchedPhrases.push(new URL(url).searchParams.get("q")); return jsonResponse({ itemSummaries: [] }); } },
      ], async () => {
        await startFinderRun("manual", "run-pocket-only", "pocket_knife");
        assert.equal(searchedPhrases.length, 1);
        assert.ok(searchedPhrases[0].startsWith("knife lot"), "a pocket-knife-scoped run must never search the carving-set keywords");
      });
    });
  });
});

test("a running carving-set-scoped run never blocks a concurrently started pocket-knife-scoped run, or vice versa", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_runs: [{ id: "r1", run_key: "carving-in-progress", trigger: "manual", category: "carving_set", status: "running", started_at: new Date().toISOString() }],
    }, async () => {
      await withFetch([tokenRoute, { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [] }) }], async () => {
        const { created } = await startFinderRun("manual", "new-pocket-run", "pocket_knife");
        assert.equal(created, true, "a different-category active run must not block this scoped run");
      });
    });
  });
});

test("an unscoped (automated) active run blocks a scoped manual run from starting", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_runs: [{ id: "r1", run_key: "automated-in-progress", trigger: "scheduled", category: null, status: "running", started_at: new Date().toISOString() }],
    }, async () => {
      const { created, run } = await startFinderRun("manual", "new-pocket-run", "pocket_knife");
      assert.equal(created, false, "an unscoped run touches every keyword, so it must still block scoped manual runs");
      assert.equal(run.id, "r1");
    });
  });
});

// A Sheffield carving-set candidate now always needs a vision material check before it can
// qualify (see lib/carving-set-finder.ts's initialCarvingSetRow), gated by the same 30-candidate
// volume threshold as a case-ambiguous item — so this run needs more than 30 Sheffield candidates
// to ever reach vision at all. 30 fixed-price padding items (skipped by the default auctions_only
// notify mode, so they generate no emails of their own) plus the one real AUCTION target item
// clears that gate without disturbing the "one email per category" assertion this test exists for.
function shefPaddingItem(index) {
  return {
    itemId: `v1|carving-pad-${index}|0`, title: "Sheffield Carving Set with Fitted Case",
    shortDescription: "", itemWebUrl: `https://www.ebay.com/itm/carving-pad-${index}`, image: { imageUrl: `https://i.ebayimg.com/carving-pad-${index}.jpg` },
    price: { value: "150.00", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }], buyingOptions: ["FIXED_PRICE"],
  };
}

test("a single run that qualifies both a pocket-knife and a carving-set item sends two separate emails, never one mixed email", async (t) => {
  await withEnv(ENV, async () => {
    const sent = [];
    mockMailer(t, sent);
    await withFakeBackend({
      finder_keywords: [
        { id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" },
        { id: "k2", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-02" },
      ],
    }, async () => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: (url) => new URL(url).searchParams.get("q").startsWith("sheffield carving set")
            ? jsonResponse({ itemSummaries: [
                ...Array.from({ length: 30 }, (_, index) => shefPaddingItem(index)),
                {
                  itemId: "v1|carving|0", title: "Antique Sheffield Carving Set, carbon steel blade, with fitted case",
                  shortDescription: "", itemWebUrl: "https://www.ebay.com/itm/carving", image: { imageUrl: "https://i.ebayimg.com/carving.jpg" },
                  price: { value: "180.00", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }], buyingOptions: ["AUCTION"],
                },
              ] })
            : jsonResponse({ itemSummaries: [{
                itemId: "v1|pocket|0", title: "Lot of 10 Smith & Wesson Pocket Knives",
                shortDescription: "", itemWebUrl: "https://www.ebay.com/itm/pocket", image: { imageUrl: "https://i.ebayimg.com/pocket.jpg" },
                price: { value: "30.00", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "5.00", currency: "USD" } }], buyingOptions: ["AUCTION"],
              }] }),
        },
      ], async () => {
        const { run } = await startFinderRun("manual", "run-mixed-categories");
        assert.equal(run.qualified, 1, "the pocket-knife item resolves and qualifies from text alone; every Sheffield candidate is left pending on vision");
        assert.equal(sent.length, 1, "only the pocket-knife email fires from this run's text pass");
      });
      await withFetch([
        tokenRoute,
        // processCarvingSetRow now fetches the item's full description before ever falling
        // through to vision (see the comment above that fetch in lib/finder-service.ts).
        { test: (url) => url.startsWith("https://api.sandbox.ebay.com/buy/browse/v1/item/"), respond: () => jsonResponse({ description: "" }) },
        { test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }) },
        { test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ hasCase: true, pieceCount: 2, confidence: 0.95, uncertaintyReason: "", material: "carbon_steel", handleMaterial: "stag" }) }] } }] }) },
      ], async () => {
        const { processed } = await processPendingFinderItems(40);
        assert.equal(processed, 31, "all 30 padding items plus the one real target item get vision-confirmed");
        assert.equal(sent.length, 2, "one email per category, never combined");
      });
      const subjects = sent.map((message) => message.subject).sort();
      assert.match(subjects[0], /carving set/);
      assert.match(subjects[1], /pocket knife/);
      const carvingEmail = sent.find((message) => /carving set/.test(message.subject));
      const pocketEmail = sent.find((message) => /pocket knife/.test(message.subject));
      assert.match(carvingEmail.html, /Sheffield Carving Set/);
      assert.doesNotMatch(carvingEmail.html, /Smith &amp; Wesson/);
      assert.match(pocketEmail.html, /Smith &amp; Wesson/);
      assert.doesNotMatch(pocketEmail.html, /Sheffield Carving Set/);
    });
  });
});
