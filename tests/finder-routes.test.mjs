import assert from "node:assert/strict";
import test from "node:test";
import { DELETE as itemsDelete, PATCH as itemsPatch } from "../app/api/finder/items/route.ts";
import { POST as gixenRetry } from "../app/api/finder/items/gixen/route.ts";
import { POST as keywordsPost, PATCH as keywordsPatch, DELETE as keywordsDelete } from "../app/api/finder/keywords/route.ts";
import { GET as overviewGet } from "../app/api/finder/route.ts";
import { POST as runPost } from "../app/api/finder/run/route.ts";
import { POST as tickPost } from "../app/api/finder/tick/route.ts";
import { GET as archivedGet } from "../app/api/finder/archived/route.ts";
import { __resetGixenDriver, __setGixenDriver } from "../lib/gixen-client.ts";
import { COOKIE_NAME, staffSessionToken } from "../lib/staff-auth.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { textResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

const STAFF_PASSWORD = "test-staff-password";
const BASE_ENV = { APP_STAFF_PASSWORD: STAFF_PASSWORD, BID_SCHEDULER_SECRET: "scheduler-secret", CRON_SECRET: "" };

function req(url, init = {}) { return new Request(url, init); }
function unauthed(url, init = {}) {
  return req(url, { ...init, headers: { ...(init.headers || {}), cookie: `${COOKIE_NAME}=not-the-right-token` } });
}
function asStaff(url, init = {}) {
  const token = staffSessionToken(STAFF_PASSWORD);
  return req(url, { ...init, headers: { ...(init.headers || {}), cookie: `${COOKIE_NAME}=${token}` } });
}
function jsonBody(body) { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }

async function withRoutesBackend(seed, fn) {
  const fake = createFakeSupabase(seed);
  fake.setRpc("reserve_finder_vision_usage", () => ({ data: { reserved: true }, error: null }));
  const restoreFrom = supabaseAdmin.from;
  const restoreRpc = supabaseAdmin.rpc;
  supabaseAdmin.from = fake.from.bind(fake);
  supabaseAdmin.rpc = fake.rpc.bind(fake);
  try { await fn(fake); } finally { supabaseAdmin.from = restoreFrom; supabaseAdmin.rpc = restoreRpc; }
}

test("every staff route rejects a request without valid staff auth", async () => {
  await withEnv(BASE_ENV, async () => {
    await withRoutesBackend({ finder_keywords: [], finder_items: [] }, async () => {
      const cases = [
        () => overviewGet(unauthed("https://x.test/api/finder")),
        () => runPost(unauthed("https://x.test/api/finder/run", { method: "POST" })),
        () => archivedGet(unauthed("https://x.test/api/finder/archived")),
        () => itemsPatch(unauthed("https://x.test/api/finder/items", jsonBody({ ebayItemIds: ["1"] }))),
        () => itemsDelete(unauthed("https://x.test/api/finder/items", jsonBody({ ids: ["1"] }))),
        () => gixenRetry(unauthed("https://x.test/api/finder/items/gixen", jsonBody({ ebayItemId: "1" }))),
        () => keywordsPost(unauthed("https://x.test/api/finder/keywords", jsonBody({ phrase: "x" }))),
        () => keywordsPatch(unauthed("https://x.test/api/finder/keywords", jsonBody({ id: "1", enabled: false }))),
        () => keywordsDelete(unauthed("https://x.test/api/finder/keywords?id=1", { method: "DELETE" })),
      ];
      for (const call of cases) {
        const response = await call();
        assert.equal(response.status, 403);
        assert.match((await response.json()).error, /access required/i);
      }
    });
  });
});

test("GET /api/finder returns the overview for staff", async () => {
  await withEnv(BASE_ENV, async () => {
    await withRoutesBackend({ finder_keywords: [], finder_items: [], finder_runs: [], finder_vision_usage: [] }, async () => {
      const response = await overviewGet(asStaff("https://x.test/api/finder"));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.counts, { pending: 0, rejected: 0, qualified: 0 });
      assert.ok(body.settings);
    });
  });
});

test("POST /api/finder/run starts and drains with an empty keyword list", async () => {
  await withEnv(BASE_ENV, async () => {
    await withRoutesBackend({ finder_keywords: [], finder_items: [] }, async () => {
      const response = await runPost(asStaff("https://x.test/api/finder/run", { method: "POST" }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.run.created, true);
      assert.deepEqual(body.queue, { processed: 0, deferred: 0 });
    });
  });
});

test("POST /api/finder/tick accepts either the scheduler secret or staff auth", async () => {
  await withEnv(BASE_ENV, async () => {
    await withRoutesBackend({ finder_keywords: [], finder_items: [] }, async () => {
      const bySecret = await tickPost(req("https://x.test/api/finder/tick", { method: "POST", headers: { "x-bid-scheduler-secret": "scheduler-secret" } }));
      assert.equal(bySecret.status, 200);
      const byStaff = await tickPost(asStaff("https://x.test/api/finder/tick", { method: "POST" }));
      assert.equal(byStaff.status, 200);
      const rejected = await tickPost(unauthed("https://x.test/api/finder/tick", { method: "POST" }));
      assert.equal(rejected.status, 403);
    });
  });
});

test("GET /api/finder/archived returns dismissed qualified items", async () => {
  await withEnv(BASE_ENV, async () => {
    await withRoutesBackend({ finder_items: [{ ebay_item_id: "1", status: "qualified", dismissed_at: "2026-01-01" }] }, async () => {
      const response = await archivedGet(asStaff("https://x.test/api/finder/archived"));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.results.length, 1);
    });
  });
});

test("PATCH /api/finder/items archives and restores by setting dismissed_at", async () => {
  await withEnv(BASE_ENV, async () => {
    await withRoutesBackend({ finder_items: [{ ebay_item_id: "1", status: "qualified", dismissed_at: null }] }, async (fake) => {
      const missing = await itemsPatch(asStaff("https://x.test/api/finder/items", jsonBody({ ebayItemIds: [] })));
      assert.equal(missing.status, 400);

      const archive = await itemsPatch(asStaff("https://x.test/api/finder/items", jsonBody({ ebayItemIds: ["1"], dismissed: true })));
      assert.equal(archive.status, 200);
      assert.ok(fake.tables.finder_items[0].dismissed_at);

      const restore = await itemsPatch(asStaff("https://x.test/api/finder/items", jsonBody({ ebayItemIds: ["1"], dismissed: false })));
      assert.equal(restore.status, 200);
      assert.equal(fake.tables.finder_items[0].dismissed_at, null);
    });
  });
});

test("DELETE /api/finder/items removes the matching rows", async () => {
  await withEnv(BASE_ENV, async () => {
    await withRoutesBackend({ finder_items: [{ ebay_item_id: "1" }, { ebay_item_id: "2" }] }, async (fake) => {
      const missing = await itemsDelete(asStaff("https://x.test/api/finder/items", jsonBody({ ids: [] })));
      assert.equal(missing.status, 400);

      const response = await itemsDelete(asStaff("https://x.test/api/finder/items", jsonBody({ ids: ["1"] })));
      assert.equal(response.status, 200);
      assert.deepEqual(fake.tables.finder_items.map((row) => row.ebay_item_id), ["2"]);
    });
  });
});

test("POST /api/finder/items/gixen sends the item's total cost to Gixen and persists the result", async () => {
  await withEnv({ ...BASE_ENV, GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret" }, async () => {
    await withRoutesBackend({ finder_items: [{ ebay_item_id: "v1|1|0", item_price: 30, shipping_cost: 5, total_cost: 35 }] }, async (fake) => {
      const missingId = await gixenRetry(asStaff("https://x.test/api/finder/items/gixen", jsonBody({})));
      assert.equal(missingId.status, 400);

      const notFound = await gixenRetry(asStaff("https://x.test/api/finder/items/gixen", jsonBody({ ebayItemId: "does-not-exist" })));
      assert.equal(notFound.status, 404);

      let seenMaxBid;
      await withFetch([{ test: (url) => url.includes("gixen.com/api.php"), respond: (url) => { seenMaxBid = new URL(url).searchParams.get("maxbid"); return textResponse("OK v1|1|0 ADDED"); } }], async () => {
        const response = await gixenRetry(asStaff("https://x.test/api/finder/items/gixen", jsonBody({ ebayItemId: "v1|1|0" })));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(seenMaxBid, "35.00");
        assert.equal(fake.tables.finder_items[0].gixen_status, "sent");
      });
    });
  });
});

test("POST /api/finder/items/gixen drives the browser automation path when GIXEN_AUTOMATION_MODE=browser", async () => {
  await withEnv({ ...BASE_ENV, GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret", GIXEN_AUTOMATION_MODE: "browser" }, async () => {
    await withRoutesBackend({ finder_items: [{ ebay_item_id: "v1|1|0", item_price: 30, shipping_cost: 5, total_cost: 35 }] }, async (fake) => {
      let seenMaxBid;
      const driver = {
        async launch() { return { page: {} }; },
        async login() {},
        async submitAddSnipe(page, params) { seenMaxBid = params.maxBid; return { ok: true, message: `added ${params.itemId}` }; },
        async submitDeleteSnipe() { return { ok: true, message: "n/a" }; },
      };
      __setGixenDriver(driver);
      try {
        const response = await gixenRetry(asStaff("https://x.test/api/finder/items/gixen", jsonBody({ ebayItemId: "v1|1|0" })));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(seenMaxBid, "35.00");
        assert.equal(fake.tables.finder_items[0].gixen_status, "sent");
      } finally {
        __resetGixenDriver();
      }
    });
  });
});

test("keyword CRUD: add, edit, toggle, and delete", async () => {
  await withEnv(BASE_ENV, async () => {
    await withRoutesBackend({ finder_keywords: [] }, async (fake) => {
      const blank = await keywordsPost(asStaff("https://x.test/api/finder/keywords", jsonBody({ phrase: "   " })));
      assert.equal(blank.status, 400);

      const created = await keywordsPost(asStaff("https://x.test/api/finder/keywords", jsonBody({ phrase: "  buck knife lot  " })));
      assert.equal(created.status, 200);
      const createdBody = await created.json();
      assert.equal(createdBody.phrase, "buck knife lot");
      assert.equal(fake.tables.finder_keywords.length, 1);

      const toggled = await keywordsPatch(asStaff("https://x.test/api/finder/keywords", jsonBody({ id: createdBody.id, enabled: false })));
      assert.equal(toggled.status, 200);
      assert.equal(fake.tables.finder_keywords[0].enabled, false);

      const deleted = await keywordsDelete(asStaff(`https://x.test/api/finder/keywords?id=${createdBody.id}`, { method: "DELETE" }));
      assert.equal(deleted.status, 200);
      assert.equal(fake.tables.finder_keywords.length, 0);
    });
  });
});
