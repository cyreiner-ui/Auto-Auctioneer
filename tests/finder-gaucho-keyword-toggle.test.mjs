import assert from "node:assert/strict";
import test from "node:test";
import { startFinderRun, updateGauchoSettings } from "../lib/finder-service.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

// Staff can turn off the gaucho-knife pipeline's keyword-search supplement (updateGauchoSettings)
// so a run only discovers candidates via the primary searchByImage path — see
// supabase/migrations/041_finder_gaucho_settings.sql for why: a noisy keyword net shouldn't force
// staff to also lose the image-search discovery that already covers the same ground better.

const ENV = {
  EBAY_CLIENT_ID: "client-id",
  EBAY_CLIENT_SECRET: "client-secret",
  EBAY_ENVIRONMENT: "sandbox",
};

const TOKEN_URL = "https://api.sandbox.ebay.com/identity/v1/oauth2/token";
const KEYWORD_SEARCH_URL = "https://api.sandbox.ebay.com/buy/browse/v1/item_summary/search";
const IMAGE_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search_by_image";
const tokenRoute = { test: (url) => url.startsWith(TOKEN_URL), respond: () => jsonResponse({ access_token: "fake-token" }) };

async function withFakeBackend(seed, fn) {
  const fake = createFakeSupabase(seed);
  fake.setFile("finder-reference-images", "ref1.jpg", [1, 2, 3], "image/jpeg");
  const restoreFrom = supabaseAdmin.from;
  const restoreStorage = supabaseAdmin.storage;
  supabaseAdmin.from = fake.from.bind(fake);
  supabaseAdmin.storage = fake.storage;
  try { await fn(fake); } finally { supabaseAdmin.from = restoreFrom; supabaseAdmin.storage = restoreStorage; }
}

function seed(overrides = {}) {
  return {
    finder_keywords: [{ id: "k1", phrase: "gaucho knife", enabled: true, created_at: "2026-01-01" }],
    finder_reference_images: [{ id: "ref1", storage_path: "ref1.jpg", category: "gaucho_knife", created_at: "2026-01-01" }],
    finder_gaucho_settings: [],
    ...overrides,
  };
}

test("startFinderRun(gaucho_knife) skips the keyword search but still runs image search when keyword search is disabled", async () => {
  await withEnv(ENV, async () => {
    let keywordSearches = 0;
    let imageSearches = 0;
    await withFakeBackend(seed({ finder_gaucho_settings: [{ id: true, keyword_search_enabled: false, created_at: "2026-01-01" }] }), async () => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(IMAGE_SEARCH_URL), respond: () => { imageSearches++; return jsonResponse({ itemSummaries: [] }); } },
        { test: (url) => url.startsWith(KEYWORD_SEARCH_URL), respond: () => { keywordSearches++; return jsonResponse({ itemSummaries: [] }); } },
      ], async () => {
        await startFinderRun("manual", "run-keyword-disabled", "gaucho_knife");
      });
    });
    assert.equal(keywordSearches, 0, "no keyword search should run once the toggle is off");
    assert.equal(imageSearches, 1, "image search must still run — the toggle only turns off the keyword supplement");
  });
});

test("startFinderRun(gaucho_knife) runs both the keyword search and the image search when the toggle is on (the default)", async () => {
  await withEnv(ENV, async () => {
    let keywordSearches = 0;
    let imageSearches = 0;
    await withFakeBackend(seed(), async () => {
      await withFetch([
        tokenRoute,
        { test: (url) => url.startsWith(IMAGE_SEARCH_URL), respond: () => { imageSearches++; return jsonResponse({ itemSummaries: [] }); } },
        { test: (url) => url.startsWith(KEYWORD_SEARCH_URL), respond: () => { keywordSearches++; return jsonResponse({ itemSummaries: [] }); } },
      ], async () => {
        await startFinderRun("manual", "run-keyword-enabled", "gaucho_knife");
      });
    });
    // 1 gaucho keyword, searched twice (best-match + the supplemental newlyListed pass — see
    // scanKeyword in lib/finder-service.ts).
    assert.equal(keywordSearches, 2, "the keyword search must run by default (no finder_gaucho_settings row at all — falls back to the enabled default)");
    assert.equal(imageSearches, 1);
  });
});

test("updateGauchoSettings persists the toggle", async () => {
  await withFakeBackend(seed(), async (fake) => {
    await updateGauchoSettings({ keywordSearchEnabled: false });
    assert.equal(fake.tables.finder_gaucho_settings.find((row) => row.id === true).keyword_search_enabled, false);
  });
});
