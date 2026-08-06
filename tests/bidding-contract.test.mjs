import assert from "node:assert/strict";
import test from "node:test";
import { validateBidInput } from "../lib/bid-validation.ts";
import { ebayApiBaseUrl, ebayAuthBaseUrl, getEbayEnvironment } from "../lib/ebay-endpoints.ts";
import { buildEbayConsentUrl, getEbayOAuthRuName, getEbayOAuthScopes } from "../lib/ebay-oauth.ts";
import { isSchedulerRequest } from "../lib/scheduler-auth.ts";
import { ACTIVE_BID_PAGE_SIZE, listActiveBidLots } from "../lib/bid-window.ts";
import scheduler from "../scheduler/index.ts";

const validBid = (overrides = {}) => ({
  ebayItemId: "166824019402",
  ebayUrl: "https://www.ebay.com/itm/166824019402",
  title: "Sandbox lot",
  accountId: "account-1",
  maxBid: 100,
  currency: "USD",
  bidWindowStart: "2026-08-04T12:00:00.000Z",
  bidWindowEnd: "2026-08-04T12:05:00.000Z",
  ...overrides,
});

test("selects the correct eBay sandbox and production hosts", () => {
  assert.equal(getEbayEnvironment("sandbox"), "sandbox");
  assert.equal(ebayApiBaseUrl("sandbox"), "https://api.sandbox.ebay.com");
  assert.equal(ebayAuthBaseUrl("sandbox"), "https://auth.sandbox.ebay.com");
  assert.equal(ebayApiBaseUrl("production"), "https://api.ebay.com");
  assert.throws(() => getEbayEnvironment("staging"), /EBAY_ENVIRONMENT/);
});

test("builds eBay OAuth consent with a RuName and the auction scopes", () => {
  const ruName = "Example_Company-ExampleApp-Prod-abcd1234";
  const url = buildEbayConsentUrl("client-id", ruName, "csrf-state", "production");
  assert.equal(url.origin, "https://auth.ebay.com");
  assert.equal(url.searchParams.get("redirect_uri"), ruName);
  assert.equal(url.searchParams.get("state"), "csrf-state");
  assert.equal(getEbayOAuthScopes(), "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/buy.offer.auction");
});

test("rejects a callback URL where eBay requires its RuName", () => {
  assert.throws(() => getEbayOAuthRuName({ EBAY_OAUTH_RUNAME: "https://example.test/api/ebay/oauth/callback" }), /RuName, not the callback URL/);
  assert.equal(getEbayOAuthRuName({ EBAY_OAUTH_REDIRECT_URI: "Legacy-Compatible-RuName" }), "Legacy-Compatible-RuName");
});

test("accepts custom scheduler and Vercel cron credentials independently", () => {
  const secrets = { BID_SCHEDULER_SECRET: "worker-secret", CRON_SECRET: "vercel-secret" };
  assert.equal(isSchedulerRequest(new Headers({ "x-bid-scheduler-secret": "worker-secret" }), secrets), true);
  assert.equal(isSchedulerRequest(new Headers({ authorization: "Bearer vercel-secret" }), secrets), true);
  assert.equal(isSchedulerRequest(new Headers({ authorization: "Bearer worker-secret" }), secrets), false);
  assert.equal(isSchedulerRequest(new Headers(), secrets), false);
});

test("validates bid amounts, windows, URLs, and budgets", () => {
  assert.equal(validateBidInput(validBid()).ok, true);
  assert.equal(validateBidInput(validBid({ accountId: undefined, executionMode: "manual" })).value.accountId, null);
  assert.match(validateBidInput(validBid({ accountId: undefined, executionMode: "automatic" })).error, /account is required/);
  assert.match(validateBidInput(validBid({ maxBid: 0 })).error, /Max bid/);
  assert.match(validateBidInput(validBid({ allInBudget: 99 })).error, /budget/);
  assert.match(validateBidInput(validBid({ ebayUrl: "https://example.com/item/166824019402" })).error, /eBay listing URL/);
  assert.match(validateBidInput(validBid({ bidWindowEnd: "2026-08-04T11:59:00.000Z" })).error, /after/);
});

test("paginates every active lot instead of stopping at 100", async () => {
  const lots = Array.from({ length: ACTIVE_BID_PAGE_SIZE + 1 }, (_, index) => ({ id: String(index) }));
  const ranges = [];
  const client = {
    from() {
      const query = {
        select() { return query; },
        eq() { return query; },
        lte() { return query; },
        gte() { return query; },
        order() { return query; },
        range(from, to) {
          ranges.push([from, to]);
          return Promise.resolve({ data: lots.slice(from, to + 1), error: null });
        },
      };
      return query;
    },
  };
  const result = await listActiveBidLots(client, new Date().toISOString());
  assert.equal(result.length, lots.length);
  assert.deepEqual(ranges, [[0, 99], [100, 199]]);
});

test("Cloudflare scheduler posts the shared secret and tolerates the disabled 503", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ enabled: false }), { status: 503 });
    };
    await scheduler.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, { BID_RUN_URL: "https://example.test/api/bids/run", BID_SCHEDULER_SECRET: "worker-secret" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.test/api/bids/run");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["x-bid-scheduler-secret"], "worker-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloudflare scheduler fails on unexpected endpoint errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });
    await assert.rejects(() => scheduler.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, { BID_RUN_URL: "https://example.test/api/bids/run", BID_SCHEDULER_SECRET: "worker-secret" }), /502/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloudflare scheduler ticks the finder with the same protected secret", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await scheduler.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, { BID_RUN_URL: "https://example.test/api/bids/run", FINDER_TICK_URL: "https://example.test/api/finder/tick", BID_SCHEDULER_SECRET: "worker-secret" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://example.test/api/finder/tick");
    assert.equal(calls[1].init.headers["x-bid-scheduler-secret"], "worker-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
