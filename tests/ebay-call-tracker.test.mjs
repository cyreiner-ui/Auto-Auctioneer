import assert from "node:assert/strict";
import test from "node:test";
import { getEbayApiCallsToday, recordEbayApiCall } from "../lib/ebay-call-tracker.ts";
import { dayKey } from "../lib/finder-core.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { withEnv } from "./helpers/fake-fetch.mjs";

const SUPABASE_ENV = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" };

function withFakeSupabase(seed, fn) {
  const fake = createFakeSupabase(seed);
  return (async () => {
    const restoreFrom = supabaseAdmin.from;
    const restoreRpc = supabaseAdmin.rpc;
    supabaseAdmin.from = fake.from.bind(fake);
    supabaseAdmin.rpc = fake.rpc.bind(fake);
    try { return await fn(fake); } finally { supabaseAdmin.from = restoreFrom; supabaseAdmin.rpc = restoreRpc; }
  })();
}

test("recordEbayApiCall does nothing when Supabase is not configured", async () => {
  await withEnv({ SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" }, async () => {
    await withFakeSupabase({}, async () => {
      const restoreRpc = supabaseAdmin.rpc;
      supabaseAdmin.rpc = () => { throw new Error("should not call rpc when Supabase is unconfigured"); };
      try { await assert.doesNotReject(() => recordEbayApiCall()); } finally { supabaseAdmin.rpc = restoreRpc; }
    });
  });
});

test("recordEbayApiCall calls the increment RPC with today's day key when configured", async () => {
  await withEnv(SUPABASE_ENV, async () => {
    let seenParams;
    await withFakeSupabase({}, async (fake) => {
      fake.setRpc("increment_ebay_api_calls", (params) => { seenParams = params; return { data: 1, error: null }; });
      await recordEbayApiCall();
    });
    assert.deepEqual(seenParams, { p_day: dayKey() });
  });
});

test("recordEbayApiCall swallows an RPC error rather than throwing", async () => {
  await withEnv(SUPABASE_ENV, async () => {
    await withFakeSupabase({}, async (fake) => {
      fake.setRpc("increment_ebay_api_calls", () => { throw new Error("boom"); });
      await assert.doesNotReject(() => recordEbayApiCall());
    });
  });
});

test("getEbayApiCallsToday returns 0 when no row exists yet for today", async () => {
  await withFakeSupabase({}, async () => {
    const result = await getEbayApiCallsToday();
    assert.equal(result, 0);
  });
});

test("getEbayApiCallsToday returns today's call count", async () => {
  await withFakeSupabase({ ebay_api_calls_daily: [{ day: dayKey(), calls: 42 }] }, async () => {
    const result = await getEbayApiCallsToday();
    assert.equal(result, 42);
  });
});

test("getEbayApiCallsToday ignores a row for a different day", async () => {
  await withFakeSupabase({ ebay_api_calls_daily: [{ day: "2000-01-01", calls: 999 }] }, async () => {
    const result = await getEbayApiCallsToday();
    assert.equal(result, 0);
  });
});
