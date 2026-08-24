import assert from "node:assert/strict";
import test from "node:test";
import { processPendingFinderItems, updateProcessingPaused } from "../lib/finder-service.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { withEnv, withFetch } from "./helpers/fake-fetch.mjs";

// Staff want a processing pause wired separately for each of the three finder tracks (see
// supabase/migrations/042_finder_processing_paused.sql / updateProcessingPaused) — pausing one
// must never stall or touch the other two, and a paused row must defer without spending a single
// eBay/Gemini call or counting against its own attempts (a long pause must never push a row into
// "error"). Every processPendingFinderItems call below runs under withFetch([]) — no routes
// registered at all — so any network call a paused row's handler makes would throw "Unmocked
// fetch call", which is the enforcement mechanism for "no call was made".

const ENV = {
  EBAY_CLIENT_ID: "client-id",
  EBAY_CLIENT_SECRET: "client-secret",
  EBAY_ENVIRONMENT: "sandbox",
  GEMINI_API_KEY: "gemini-key",
};

async function withFakeBackend(seed, fn) {
  const fake = createFakeSupabase(seed);
  fake.setFile("finder-reference-images", "ref1.jpg", [1, 2, 3], "image/jpeg");
  const restoreFrom = supabaseAdmin.from;
  const restoreStorage = supabaseAdmin.storage;
  supabaseAdmin.from = fake.from.bind(fake);
  supabaseAdmin.storage = fake.storage;
  try { await fn(fake); } finally { supabaseAdmin.from = restoreFrom; supabaseAdmin.storage = restoreStorage; }
}

function pendingRow(overrides = {}) {
  const past = new Date(Date.now() - 60_000).toISOString();
  return {
    ebay_item_id: "v1|1|0", run_id: null, keyword_phrases: [], title: "Item", short_description: "",
    ebay_url: "https://ebay.test/itm/1", image_url: "https://i.ebayimg.com/1.jpg", item_price: 10,
    shipping_cost: null, shipping_source: null, currency: "USD", buying_options: ["FIXED_PRICE"],
    knife_count: null, item_category: null, status: "pending", attempts: 0,
    carving_piece_count: null, carving_has_case: null, carving_carbon_steel: null, carving_handle_material: null,
    discovered_at: "2026-01-01", next_attempt_at: past,
    ...overrides,
  };
}

test("processPendingFinderItems defers a paused pocket-knife row without any network call", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_items: [pendingRow({ ebay_item_id: "pk1", keyword_phrases: ["knife lot"] })],
      finder_processing_settings: [{ category: "pocket_knife", paused: true }],
    }, async (fake) => {
      const { processed, deferred } = await withFetch([], () => processPendingFinderItems(5));
      assert.equal(processed, 0);
      assert.equal(deferred, 1);
      const row = fake.tables.finder_items.find((r) => r.ebay_item_id === "pk1");
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 0, "a paused defer must never count against attempts");
      assert.equal(row.reason, "Pocket-knife processing is paused by staff.");
      assert.ok(new Date(row.next_attempt_at).getTime() > Date.now(), "must be pushed into the future so it isn't immediately re-picked-up");
    });
  });
});

test("processPendingFinderItems defers a paused carving-set row without any network call", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_items: [pendingRow({ ebay_item_id: "cs1", keyword_phrases: ["sheffield carving set"] })],
      finder_processing_settings: [{ category: "carving_set", paused: true }],
    }, async (fake) => {
      const { processed, deferred } = await withFetch([], () => processPendingFinderItems(5));
      assert.equal(processed, 0);
      assert.equal(deferred, 1);
      const row = fake.tables.finder_items.find((r) => r.ebay_item_id === "cs1");
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 0);
      assert.equal(row.reason, "Carving-set processing is paused by staff.");
    });
  });
});

test("processPendingFinderItems defers a paused gaucho-knife row without any network call", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_items: [pendingRow({ ebay_item_id: "gk1", keyword_phrases: ["gaucho knife"], item_category: "gaucho_knife" })],
      finder_reference_images: [{ id: "ref1", storage_path: "ref1.jpg", category: "gaucho_knife", created_at: "2026-01-01" }],
      finder_processing_settings: [{ category: "gaucho_knife", paused: true }],
    }, async (fake) => {
      const { processed, deferred } = await withFetch([], () => processPendingFinderItems(5));
      assert.equal(processed, 0);
      assert.equal(deferred, 1);
      const row = fake.tables.finder_items.find((r) => r.ebay_item_id === "gk1");
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 0);
      assert.equal(row.reason, "Gaucho-knife vision processing is paused by staff.");
    });
  });
});

test("pausing one track leaves the other two processing normally in the same batch", async () => {
  await withEnv(ENV, async () => {
    await withFakeBackend({
      finder_items: [
        pendingRow({ ebay_item_id: "pk1", keyword_phrases: ["knife lot"] }),
        pendingRow({ ebay_item_id: "cs1", keyword_phrases: ["sheffield carving set"] }),
      ],
      finder_processing_settings: [{ category: "pocket_knife", paused: true }],
    }, async (fake) => {
      // No fetch routes registered. The paused pocket-knife row must defer cleanly without ever
      // reaching a network call; the unpaused carving-set row, by contrast, does reach its own
      // item-description lookup, whose "Unmocked fetch call" failure is caught by
      // processCarvingSetRow's own try/catch and recorded as a real (counted) attempt — proving it
      // was actually processed rather than silently skipped like the paused row.
      await withFetch([], () => processPendingFinderItems(5));
      const pk1 = fake.tables.finder_items.find((r) => r.ebay_item_id === "pk1");
      assert.equal(pk1.reason, "Pocket-knife processing is paused by staff.");
      assert.equal(pk1.status, "pending");
      assert.equal(pk1.attempts, 0);
      const cs1 = fake.tables.finder_items.find((r) => r.ebay_item_id === "cs1");
      assert.equal(cs1.attempts, 1, "the unpaused carving-set row must have actually attempted its own processing, not been silently skipped too");
      assert.match(cs1.reason, /Unmocked fetch call/);
    });
  });
});

test("updateProcessingPaused/getProcessingPaused round-trip independently per category", async () => {
  await withFakeBackend({ finder_processing_settings: [] }, async (fake) => {
    await updateProcessingPaused("gaucho_knife", true);
    assert.equal(fake.tables.finder_processing_settings.find((row) => row.category === "gaucho_knife").paused, true);
    // pocket_knife/carving_set were never touched — must not exist yet, so a fresh lookup falls
    // back to "not paused" rather than accidentally inheriting gaucho_knife's row.
    assert.equal(fake.tables.finder_processing_settings.find((row) => row.category === "pocket_knife"), undefined);
  });
});
