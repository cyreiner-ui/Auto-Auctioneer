import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { PATCH as keywordsPatch } from "../app/api/finder/keywords/route.ts";
import { archivedFinderItems, finderOverview, keywordCategory, processPendingFinderItems, startFinderRun } from "../lib/finder-service.ts";
import { CARVING_SET_PHRASES } from "../lib/carving-set-finder.ts";
import { GAUCHO_KNIFE_PHRASES, imageSearchPhrase } from "../lib/gaucho-knife-finder.ts";
import { imageSearchPhrase as mateGourdImageSearchPhrase } from "../lib/mate-gourd-finder.ts";
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
        // Each of the 2 keywords is searched twice now (the best-match pass, plus the
        // supplemental newlyListed pass — see scanKeyword in lib/finder-service.ts), so 4 total.
        assert.equal(searchedPhrases.length, 4);
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
        // The 1 enabled keyword is searched twice (best-match + newlyListed), so 2 total.
        assert.equal(searchedPhrases.length, 2);
        assert.ok(searchedPhrases[0].startsWith("knife lot"), "a pocket-knife-scoped run must never search the carving-set keywords");
      });
    });
  });
});

function fakeItemPage(count, offset) {
  return Array.from({ length: count }, (_, i) => ({
    itemId: `v1|browse-${offset + i}|0`,
    title: `Flatware set ${offset + i}`,
    itemWebUrl: `https://www.ebay.com/itm/${offset + i}`,
  }));
}

test("the Flatware Sets category browse stays capped at 1500 even when EBAY_FINDER_RESULTS_PER_KEYWORD is tuned for keyword searches", async () => {
  await withEnv({ ...ENV, EBAY_FINDER_RESULTS_PER_KEYWORD: "50" }, async () => {
    const keywordLimits = [];
    const categoryBrowseLimits = [];
    await withFakeBackend({
      finder_keywords: [{ id: "k2", phrase: "sheffield carving set", enabled: true, created_at: "2026-01-02" }],
    }, async () => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: (url) => {
            const params = new URL(url).searchParams;
            const limit = Number(params.get("limit"));
            if (params.get("category_ids")) {
              categoryBrowseLimits.push(limit);
              // Return a full page every time so the category browse's own pagination keeps
              // going through all of its planned pages instead of stopping early — otherwise this
              // test couldn't tell "capped at 500" apart from "stopped after the first page".
              return jsonResponse({ itemSummaries: fakeItemPage(limit, Number(params.get("offset"))) });
            }
            keywordLimits.push(limit);
            return jsonResponse({ itemSummaries: [] });
          },
        },
      ], async () => {
        await startFinderRun("manual", "run-carving-budget-check", "carving_set");
        // The overridden env var does shrink the keyword search's own page size (the best-match
        // pass); the supplemental newlyListed pass runs alongside it at its own independent
        // default page size, which also happens to be 50 (FINDER_DEFAULTS.newlyListedResultsPerKeyword) —
        // hence two 50s here, not one...
        assert.deepEqual(keywordLimits, [50, 50]);
        // ...but the category browse pages in fixed 200-per-request chunks up to its own
        // independent 1500 cap (see CARVING_SET_CATEGORY_BROWSE_LIMIT), unaffected either way.
        assert.deepEqual(categoryBrowseLimits, [200, 200, 200, 200, 200, 200, 200, 100]);
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
        assert.equal(sent.length, 0, "the qualification email waits for the whole run to finish, including the still-pending carving-set vision analysis");
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

// ---------------------------------------------------------------------------
// Cross-finder isolation contract
//
// The three finder tracks (pocket_knife, carving_set, gaucho_knife) share one
// finder_keywords/finder_items table by design (see the FinderCategory comment in
// lib/finder-service.ts) — isolation is entirely a matter of app-level bookkeeping getting each
// item's category classification right, and keeping it stable. The tests below exist to catch a
// regression found in production: a carving-set (or gaucho-knife) item's classification could
// flip to plain pocket-knife whenever a *different* category's scoped run's keyword search
// happened to also match that same eBay listing, because startFinderRun overwrote keyword_phrases
// with only the current scan's own matches instead of merging with what was already stored.
//
// Whenever a new feature touches keyword classification, finder_items writes, or the
// pocket_knife/carving_set/gaucho_knife dispatch logic, extend this section with a test that
// pins down the isolation guarantee the change relies on — don't just eyeball it.
test("keywordCategory (the single canonical phrase classifier) agrees with each category's own phrase list — every other call site must reuse this function, never re-implement the test inline", () => {
  for (const phrase of CARVING_SET_PHRASES) assert.equal(keywordCategory(phrase), "carving_set", `"${phrase}" must classify as carving_set`);
  for (const phrase of GAUCHO_KNIFE_PHRASES) assert.equal(keywordCategory(phrase), "gaucho_knife", `"${phrase}" must classify as gaucho_knife`);
  assert.equal(keywordCategory("knife lot"), "pocket_knife");
  assert.equal(keywordCategory("smith and wesson knives"), "pocket_knife");
});

function sharedCarvingSetRow(overrides = {}) {
  return {
    ebay_item_id: "v1|shared-cs|0",
    run_id: "prior-run",
    keyword_phrases: ["german carving set"],
    title: "Antique German Carving Set, Stag Horn Handle, 3 pcs, with fitted case",
    short_description: "",
    ebay_url: "https://www.ebay.com/itm/shared-cs",
    image_url: null,
    item_price: 40,
    shipping_cost: 0,
    currency: "USD",
    buying_options: ["FIXED_PRICE"],
    item_end_date: null,
    knife_count: 1,
    contains_folding_knife: false,
    confidence: 0.95,
    detection_source: "text",
    item_category: "carving_set",
    carving_piece_count: 3,
    carving_has_case: true,
    carving_carbon_steel: null,
    carving_handle_material: "stag",
    status: "qualified",
    reason: null,
    attempts: 0,
    total_cost: 40,
    cost_per_knife: 40,
    discovered_at: "2026-01-01",
    first_seen_run_id: "prior-run",
    ...overrides,
  };
}

test("REGRESSION: a carving-set item's classification survives a later pocket-knife-scoped run whose keyword search also matches it, and never leaks into the pocket-knife dashboard", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_items: [sharedCarvingSetRow()],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: () => jsonResponse({ itemSummaries: [{
            itemId: "v1|shared-cs|0",
            title: "Antique German Carving Set, Stag Horn Handle, 3 pcs, with fitted case",
            shortDescription: "",
            itemWebUrl: "https://www.ebay.com/itm/shared-cs",
            image: { imageUrl: null },
            price: { value: "40.00", currency: "USD" },
            shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
            buyingOptions: ["FIXED_PRICE"],
          }] }),
        },
      ], async () => { await startFinderRun("manual", "run-pocket-remix", "pocket_knife"); });

      const row = fake.tables.finder_items.find((r) => r.ebay_item_id === "v1|shared-cs|0");
      assert.equal(row.item_category, "carving_set", "a pocket-knife-scoped run must never strip an already-established carving-set classification");
      assert.ok(row.keyword_phrases.includes("german carving set"), "the item's original carving-set phrase must survive, not be replaced by just this run's own pocket-knife phrase");
      assert.equal(row.status, "qualified", "re-evaluating under the (correctly preserved) carving-set pipeline must still qualify this item");

      const pocketOverview = await finderOverview("pocket_knife");
      assert.ok(!pocketOverview.results.some((r) => r.ebay_item_id === "v1|shared-cs|0"), "the carving-set item must never appear on the pocket-knife dashboard");
      const carvingOverview = await finderOverview("carving_set");
      assert.ok(carvingOverview.results.some((r) => r.ebay_item_id === "v1|shared-cs|0"), "it must still appear under carving-set, its original category");
    });
  });
});

function sharedGauchoKnifeRow(overrides = {}) {
  return {
    ebay_item_id: "v1|shared-gaucho|0",
    run_id: "prior-run",
    keyword_phrases: [imageSearchPhrase("ref1")],
    title: "Ornate Silver Dagger with Sheath",
    short_description: "",
    ebay_url: "https://www.ebay.com/itm/shared-gaucho",
    image_url: "https://i.ebayimg.com/gaucho.jpg",
    item_price: 120,
    shipping_cost: 10,
    currency: "USD",
    buying_options: ["FIXED_PRICE"],
    item_end_date: null,
    knife_count: 1,
    contains_folding_knife: false,
    confidence: 0.9,
    detection_source: "vision",
    item_category: "gaucho_knife",
    gaucho_match_confidence: 0.9,
    gaucho_maker_match: true,
    gaucho_matched_reference_id: "ref1",
    gaucho_match_notes: "Matches reference 1 closely.",
    status: "qualified",
    reason: null,
    attempts: 1,
    total_cost: 130,
    cost_per_knife: 130,
    discovered_at: "2026-01-01",
    first_seen_run_id: "prior-run",
    ...overrides,
  };
}

test("REGRESSION: a gaucho-knife item (discovered via image search, no finder_keywords phrase at all) keeps its classification after a later pocket-knife-scoped run's keyword search also matches it", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_items: [sharedGauchoKnifeRow()],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: () => jsonResponse({ itemSummaries: [{
            itemId: "v1|shared-gaucho|0",
            title: "Ornate Silver Dagger with Sheath",
            shortDescription: "",
            itemWebUrl: "https://www.ebay.com/itm/shared-gaucho",
            image: { imageUrl: "https://i.ebayimg.com/gaucho.jpg" },
            price: { value: "120.00", currency: "USD" },
            shippingOptions: [{ shippingCost: { value: "10.00", currency: "USD" } }],
            buyingOptions: ["FIXED_PRICE"],
          }] }),
        },
      ], async () => { await startFinderRun("manual", "run-pocket-remix-2", "pocket_knife"); });

      const row = fake.tables.finder_items.find((r) => r.ebay_item_id === "v1|shared-gaucho|0");
      assert.equal(row.item_category, "gaucho_knife", "a pocket-knife-scoped run must never strip an already-established gaucho-knife classification");
      assert.ok(row.keyword_phrases.includes(imageSearchPhrase("ref1")), "the item's synthetic image-search marker must survive so it's still recognized as a gaucho-knife row on every future scan");
      assert.equal(row.status, "qualified", "the prior vision verdict must still be honored, not discarded");

      const pocketOverview = await finderOverview("pocket_knife");
      assert.ok(!pocketOverview.results.some((r) => r.ebay_item_id === "v1|shared-gaucho|0"), "the gaucho-knife item must never appear on the pocket-knife dashboard");
      const gauchoOverview = await finderOverview("gaucho_knife");
      assert.ok(gauchoOverview.results.some((r) => r.ebay_item_id === "v1|shared-gaucho|0"), "it must still appear under gaucho-knife, its original category");
    });
  });
});

test("within a single unscoped scan, an eBay listing matched by both a carving-set keyword and a pocket-knife keyword resolves to exactly one category, never both", async () => {
  await withEnv(ENV, async () => {
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
          respond: () => jsonResponse({ itemSummaries: [{
            itemId: "v1|dual-match|0",
            title: "Antique Sheffield Carving Set, carbon steel blade, stag horn handle, with fitted case",
            shortDescription: "",
            itemWebUrl: "https://www.ebay.com/itm/dual-match",
            image: { imageUrl: "https://i.ebayimg.com/dual-match.jpg" },
            price: { value: "150.00", currency: "USD" },
            shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
            buyingOptions: ["FIXED_PRICE"],
          }] }),
        },
      ], async () => { await startFinderRun("manual", "run-dual-match"); });

      // A Sheffield candidate always needs a vision material check before it can qualify (see
      // lib/carving-set-finder.ts's initialCarvingSetRow), so this listing is left "pending" by
      // the text pass rather than "qualified" — check the category-scoped counts (which cover
      // every status) instead of `results` (which only ever lists qualified items).
      const pocketOverview = await finderOverview("pocket_knife");
      const carvingOverview = await finderOverview("carving_set");
      assert.deepEqual(pocketOverview.counts, { pending: 0, rejected: 0, qualified: 0 }, "the listing must not be counted anywhere in the pocket-knife track");
      assert.deepEqual(carvingOverview.counts, { pending: 1, rejected: 0, qualified: 0 }, "it must be counted exactly once, under carving-set — its only correct category");
    });
  });
});

function sharedMateGourdRow(overrides = {}) {
  return {
    ebay_item_id: "v1|shared-gourd|0",
    run_id: "prior-run",
    keyword_phrases: [mateGourdImageSearchPhrase("gourd-ref1")],
    title: "Antique Silver Mate Gourd",
    short_description: "",
    ebay_url: "https://www.ebay.com/itm/shared-gourd",
    image_url: "https://i.ebayimg.com/gourd.jpg",
    item_price: 60,
    shipping_cost: 12,
    currency: "USD",
    buying_options: ["FIXED_PRICE"],
    item_end_date: null,
    knife_count: 1,
    contains_folding_knife: false,
    confidence: 0.95,
    detection_source: "vision",
    item_category: "mate_gourd",
    mate_gourd_match_confidence: 0.95,
    mate_gourd_matched_reference_id: "gourd-ref1",
    mate_gourd_match_notes: "Matches reference 1 closely.",
    status: "qualified",
    reason: null,
    attempts: 1,
    total_cost: 72,
    cost_per_knife: 72,
    discovered_at: "2026-01-01",
    first_seen_run_id: "prior-run",
    ...overrides,
  };
}

// Companion to the gaucho-knife REGRESSION test above — same cross-finder "mixing" bug class,
// checked for the fourth category. This is exactly why scopeToCategory's pocket_knife branch had
// to move from a single item_category.neq.gaucho_knife check to an item_category.not.in.(...)
// check covering both gaucho_knife and mate_gourd — a plain neq against only one of them would
// have let the other leak straight into the pocket-knife dashboard.
test("REGRESSION: a mate-gourd item (discovered via image search, no finder_keywords phrase at all) keeps its classification after a later pocket-knife-scoped run's keyword search also matches it", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_keywords: [{ id: "k1", phrase: "knife lot", enabled: true, created_at: "2026-01-01" }],
      finder_items: [sharedMateGourdRow()],
    }, async (fake) => {
      await withFetch([
        tokenRoute,
        {
          test: (url) => url.startsWith(SEARCH_URL),
          respond: () => jsonResponse({ itemSummaries: [{
            itemId: "v1|shared-gourd|0",
            title: "Antique Silver Mate Gourd",
            shortDescription: "",
            itemWebUrl: "https://www.ebay.com/itm/shared-gourd",
            image: { imageUrl: "https://i.ebayimg.com/gourd.jpg" },
            price: { value: "60.00", currency: "USD" },
            shippingOptions: [{ shippingCost: { value: "12.00", currency: "USD" } }],
            buyingOptions: ["FIXED_PRICE"],
          }] }),
        },
      ], async () => { await startFinderRun("manual", "run-pocket-remix-3", "pocket_knife"); });

      const row = fake.tables.finder_items.find((r) => r.ebay_item_id === "v1|shared-gourd|0");
      assert.equal(row.item_category, "mate_gourd", "a pocket-knife-scoped run must never strip an already-established mate-gourd classification");
      assert.ok(row.keyword_phrases.includes(mateGourdImageSearchPhrase("gourd-ref1")), "the item's synthetic image-search marker must survive so it's still recognized as a mate-gourd row on every future scan");
      assert.equal(row.status, "qualified", "the prior vision verdict must still be honored, not discarded");

      const pocketOverview = await finderOverview("pocket_knife");
      assert.ok(!pocketOverview.results.some((r) => r.ebay_item_id === "v1|shared-gourd|0"), "the mate-gourd item must never appear on the pocket-knife dashboard");
      const gourdOverview = await finderOverview("mate_gourd");
      assert.ok(gourdOverview.results.some((r) => r.ebay_item_id === "v1|shared-gourd|0"), "it must still appear under mate-gourd, its original category");
    });
  });
});
