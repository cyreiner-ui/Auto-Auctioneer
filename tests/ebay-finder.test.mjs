import assert from "node:assert/strict";
import test from "node:test";
import { getItemDescription, getItemShippingCost, searchEbayKeyword } from "../lib/ebay-finder.ts";
import { jsonResponse, textResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

const EBAY_ENV = { EBAY_CLIENT_ID: "client-id", EBAY_CLIENT_SECRET: "client-secret", EBAY_ENVIRONMENT: "sandbox" };
const TOKEN_URL = "https://api.sandbox.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.sandbox.ebay.com/buy/browse/v1/item_summary/search";

const tokenRoute = { test: (url) => url.startsWith(TOKEN_URL), respond: () => jsonResponse({ access_token: "fake-app-token" }) };

function item(overrides = {}) {
  return {
    itemId: "v1|1|0",
    title: "Lot of 10 pocket knives",
    shortDescription: "A lot of 10 pocket knives.",
    itemWebUrl: "https://www.ebay.com/itm/1",
    image: { imageUrl: "https://i.ebayimg.com/1.jpg" },
    price: { value: "30.00", currency: "USD" },
    shippingOptions: [{ shippingCost: { value: "5.50", currency: "USD" } }],
    buyingOptions: ["FIXED_PRICE"],
    itemEndDate: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

test("throws before any request when eBay credentials are not configured", async () => {
  await withEnv({ EBAY_CLIENT_ID: "", EBAY_CLIENT_SECRET: "" }, async () => {
    await withFetch([], async () => {
      await assert.rejects(() => searchEbayKeyword("knife lot", 10), /credentials are not configured/);
    });
  });
});

test("maps a search result page into finder items", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([
      tokenRoute,
      { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [item(), item({ itemId: "v1|2|0", title: "Lot of 6 knives" })] }) },
    ], async () => {
      const results = await searchEbayKeyword("knife lot", 10);
      assert.equal(results.length, 2);
      assert.deepEqual(results[0], {
        itemId: "v1|1|0",
        title: "Lot of 10 pocket knives",
        shortDescription: "A lot of 10 pocket knives.",
        itemWebUrl: "https://www.ebay.com/itm/1",
        imageUrl: "https://i.ebayimg.com/1.jpg",
        itemPrice: 30,
        shippingCost: 5.5,
        shippingCurrency: "USD",
        currency: "USD",
        buyingOptions: ["FIXED_PRICE"],
        itemEndDate: "2026-09-01T00:00:00.000Z",
      });
    });
  });
});

test("appends the default junk-word exclusions to the search query", async () => {
  await withEnv(EBAY_ENV, async () => {
    let seenQuery;
    await withFetch([
      tokenRoute,
      {
        test: (url) => url.startsWith(SEARCH_URL),
        respond: (url) => {
          seenQuery = new URL(url).searchParams.get("q");
          return jsonResponse({ itemSummaries: [] });
        },
      },
    ], async () => {
      await searchEbayKeyword("knife lot", 10);
      assert.equal(seenQuery, "knife lot -throwing -keychain -multitool -leatherman");
    });
  });
});

test("drops results missing an id, title, or URL", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([
      tokenRoute,
      { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [item(), item({ itemId: undefined })] }) },
    ], async () => {
      const results = await searchEbayKeyword("knife lot", 10);
      assert.equal(results.length, 1);
    });
  });
});

test("picks the lowest valid shipping cost among multiple options", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([
      tokenRoute,
      {
        test: (url) => url.startsWith(SEARCH_URL),
        respond: () => jsonResponse({
          itemSummaries: [item({ shippingOptions: [{ shippingCost: { value: "12.00", currency: "USD" } }, { shippingCost: { value: "not-a-number" } }, { shippingCost: { value: "4.25", currency: "USD" } }] })],
        }),
      },
    ], async () => {
      const [result] = await searchEbayKeyword("knife lot", 10);
      assert.equal(result.shippingCost, 4.25);
    });
  });
});

test("paginates across multiple pages for a large result count", async () => {
  await withEnv(EBAY_ENV, async () => {
    const seenOffsets = [];
    await withFetch([
      tokenRoute,
      {
        test: (url) => url.startsWith(SEARCH_URL),
        respond: (url) => {
          const params = new URL(url).searchParams;
          const offset = Number(params.get("offset"));
          const limit = Number(params.get("limit"));
          seenOffsets.push(offset);
          const count = offset < 400 ? limit : 100;
          return jsonResponse({ itemSummaries: Array.from({ length: count }, (_, i) => item({ itemId: `v1|${offset + i}|0` })) });
        },
      },
    ], async () => {
      const results = await searchEbayKeyword("knife lot", 500);
      assert.deepEqual(seenOffsets, [0, 200, 400]);
      assert.equal(results.length, 500);
    });
  });
});

test("stops paginating as soon as a page returns fewer results than requested", async () => {
  await withEnv(EBAY_ENV, async () => {
    let calls = 0;
    await withFetch([
      tokenRoute,
      {
        test: (url) => url.startsWith(SEARCH_URL),
        respond: (url) => {
          calls++;
          const limit = Number(new URL(url).searchParams.get("limit"));
          const count = calls === 1 ? limit : 50;
          return jsonResponse({ itemSummaries: Array.from({ length: count }, (_, i) => item({ itemId: `v1|${calls}-${i}|0` })) });
        },
      },
    ], async () => {
      await searchEbayKeyword("knife lot", 500);
      assert.equal(calls, 2);
    });
  });
});

test("throws when the search request fails", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([tokenRoute, { test: (url) => url.startsWith(SEARCH_URL), respond: () => textResponse("server error", { status: 500 }) }], async () => {
      await assert.rejects(() => searchEbayKeyword("knife lot", 10), /failed \(500\)/);
    });
  });
});

const ITEM_URL = "https://api.sandbox.ebay.com/buy/browse/v1/item/";

test("getItemShippingCost returns the computed shipping cost from the single-item endpoint", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([
      tokenRoute,
      { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ shippingOptions: [{ shippingCost: { value: "9.99", currency: "USD" } }] }) },
    ], async () => {
      const result = await getItemShippingCost("v1|1|0");
      assert.deepEqual(result, { value: 9.99, currency: "USD" });
    });
  });
});

test("getItemShippingCost returns a null value for a listing with no usable shipping option (e.g. local pickup only)", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([
      tokenRoute,
      { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ shippingOptions: [] }) },
    ], async () => {
      const result = await getItemShippingCost("v1|1|0");
      assert.deepEqual(result, { value: null, currency: "" });
    });
  });
});

test("searchEbayKeyword skips the token request entirely when a pre-fetched token is passed in", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([
      { test: (url) => url.startsWith(TOKEN_URL), respond: () => { throw new Error("should not fetch a token when one is already provided"); } },
      { test: (url) => url.startsWith(SEARCH_URL), respond: () => jsonResponse({ itemSummaries: [item()] }) },
    ], async () => {
      const results = await searchEbayKeyword("knife lot", 10, "already-have-a-token");
      assert.equal(results.length, 1);
    });
  });
});

test("getItemShippingCost skips the token request entirely when a pre-fetched token is passed in", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([
      { test: (url) => url.startsWith(TOKEN_URL), respond: () => { throw new Error("should not fetch a token when one is already provided"); } },
      { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ shippingOptions: [{ shippingCost: { value: "9.99", currency: "USD" } }] }) },
    ], async () => {
      const result = await getItemShippingCost("v1|1|0", "already-have-a-token");
      assert.deepEqual(result, { value: 9.99, currency: "USD" });
    });
  });
});

test("getItemShippingCost throws when the item lookup fails", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([tokenRoute, { test: (url) => url.startsWith(ITEM_URL), respond: () => textResponse("not found", { status: 404 }) }], async () => {
      await assert.rejects(() => getItemShippingCost("v1|1|0"), /failed \(404\)/);
    });
  });
});

test("getItemDescription strips HTML and truncates the result", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([
      tokenRoute,
      { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({ description: "<p>Lot of <b>10</b> knives.</p><p>Ships fast!</p>" }) },
    ], async () => {
      const result = await getItemDescription("v1|1|0");
      assert.equal(result, "Lot of 10 knives.\nShips fast!");
    });
  });
});

test("getItemDescription returns an empty string when the listing has no description", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([tokenRoute, { test: (url) => url.startsWith(ITEM_URL), respond: () => jsonResponse({}) }], async () => {
      const result = await getItemDescription("v1|1|0");
      assert.equal(result, "");
    });
  });
});

test("getItemDescription throws when the item lookup fails", async () => {
  await withEnv(EBAY_ENV, async () => {
    await withFetch([tokenRoute, { test: (url) => url.startsWith(ITEM_URL), respond: () => textResponse("not found", { status: 404 }) }], async () => {
      await assert.rejects(() => getItemDescription("v1|1|0"), /failed \(404\)/);
    });
  });
});

test("every eBay request carries an abort timeout, so one stalled response can't hang a batch forever", async () => {
  await withEnv(EBAY_ENV, async () => {
    const signals = [];
    await withFetch([
      { test: (url) => url.startsWith(TOKEN_URL), respond: (url, init) => { signals.push(init?.signal); return jsonResponse({ access_token: "fake-app-token" }); } },
      { test: (url) => url.startsWith(SEARCH_URL), respond: (url, init) => { signals.push(init?.signal); return jsonResponse({ itemSummaries: [] }); } },
      { test: (url) => url.startsWith(ITEM_URL), respond: (url, init) => { signals.push(init?.signal); return jsonResponse({ shippingOptions: [] }); } },
    ], async () => {
      await searchEbayKeyword("knife lot", 10);
      await getItemShippingCost("v1|1|0");
      await getItemDescription("v1|1|0");
      assert.equal(signals.length, 6);
      for (const signal of signals) assert.ok(signal instanceof AbortSignal, "expected every eBay fetch to carry an AbortSignal timeout");
    });
  });
});
