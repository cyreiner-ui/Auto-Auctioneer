import assert from "node:assert/strict";
import test from "node:test";
import { __resetGixenDriver, __setGixenDriver, addSnipe, deleteSnipe } from "../lib/gixen-client.ts";
import { textResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

const BROWSER_ENV = { GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret", GIXEN_AUTOMATION_MODE: "browser" };

// A fake GixenDriver so browser-mode behavior (session reuse, recovery, the
// never-throws guarantee) can be tested without launching real Chromium or
// touching gixen.com. `launch()` only ever needs to return a `page` — the
// real driver's `browser`/`context` aren't read anywhere else in the module.
function fakeDriver({ loginThrows = () => false, addSnipeThrows = () => false, deleteSnipeThrows = () => false } = {}) {
  const calls = { logins: 0, addSnipes: [], deleteSnipes: [] };
  return {
    calls,
    async launch() { return { page: {} }; },
    async login() {
      calls.logins += 1;
      if (loginThrows(calls.logins)) throw new Error("simulated login failure");
    },
    async submitAddSnipe(page, params) {
      calls.addSnipes.push(params);
      if (addSnipeThrows(calls.addSnipes.length)) throw "simulated non-Error throw";
      return { ok: true, message: `added ${params.itemId}` };
    },
    async submitDeleteSnipe(page, params) {
      calls.deleteSnipes.push(params);
      if (deleteSnipeThrows(calls.deleteSnipes.length)) throw new Error("simulated delete failure");
      return { ok: true, message: `deleted ${params.itemId}` };
    },
  };
}

async function withDriver(driver, fn) {
  __setGixenDriver(driver);
  try {
    await fn();
  } finally {
    __resetGixenDriver();
  }
}

// --- api mode (GIXEN_AUTOMATION_MODE unset/"api") — the dead HTTP path,
// kept only as a documented, always-fails-cleanly fallback until removed.

test("api mode: does not call Gixen when credentials are not configured", async (t) => {
  await withEnv({ GIXEN_USERNAME: "", GIXEN_PASSWORD: "" }, async () => {
    let called = false;
    await withFetch([{ test: () => true, respond: () => { called = true; return textResponse("OK 1 ADDED"); } }], async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 12.5 });
      assert.deepEqual(result, { ok: false, message: "Gixen credentials are not configured." });
      assert.equal(called, false);
    });
  });
});

test("api mode: sends the item id, max bid, and quantity to Gixen's API", async () => {
  await withEnv({ GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret" }, async () => {
    let seenUrl;
    await withFetch([{
      test: (url) => url.includes("gixen.com/api.php"),
      respond: (url) => { seenUrl = new URL(url); return textResponse("OK v1|123|0 ADDED"); },
    }], async () => {
      const result = await addSnipe({ itemId: "v1|123|0", maxBid: 27.633 });
      assert.equal(result.ok, true);
      assert.equal(result.message, "OK v1|123|0 ADDED");
      assert.equal(seenUrl.searchParams.get("username"), "buyer");
      assert.equal(seenUrl.searchParams.get("password"), "secret");
      assert.equal(seenUrl.searchParams.get("itemid"), "v1|123|0");
      assert.equal(seenUrl.searchParams.get("maxbid"), "27.63");
      assert.equal(seenUrl.searchParams.get("quantity"), "1");
    });
  });
});

test("api mode: parses a Gixen error response as a failed result", async () => {
  await withEnv({ GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret" }, async () => {
    await withFetch([{ test: () => true, respond: () => textResponse("ERROR (211): item already ended") }], async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 5 });
      assert.equal(result.ok, false);
      assert.equal(result.message, "ERROR (211): item already ended");
    });
  });
});

test("api mode: treats a non-2xx HTTP response as a failed result", async () => {
  await withEnv({ GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret" }, async () => {
    await withFetch([{ test: () => true, respond: () => textResponse("Service unavailable", { status: 503 }) }], async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 5 });
      assert.equal(result.ok, false);
      assert.match(result.message, /Gixen request failed \(503\)/);
    });
  });
});

test("api mode: deleteSnipe sends the item id under the ditemid param", async () => {
  await withEnv({ GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret" }, async () => {
    let seenUrl;
    await withFetch([{ test: () => true, respond: (url) => { seenUrl = new URL(url); return textResponse("OK v1|9|0 DELETED"); } }], async () => {
      const result = await deleteSnipe({ itemId: "v1|9|0" });
      assert.equal(result.ok, true);
      assert.equal(seenUrl.searchParams.get("ditemid"), "v1|9|0");
    });
  });
});

// --- browser mode (GIXEN_AUTOMATION_MODE=browser) — drives gixen.com's own
// web forms via a driver seam instead of real Chromium or fetch mocking.

test("browser mode: does not launch the driver when credentials are not configured", async (t) => {
  await withEnv({ ...BROWSER_ENV, GIXEN_USERNAME: "", GIXEN_PASSWORD: "" }, async () => {
    const driver = fakeDriver();
    await withDriver(driver, async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 12.5 });
      assert.deepEqual(result, { ok: false, message: "Gixen credentials are not configured." });
      assert.equal(driver.calls.logins, 0);
    });
  });
});

test("browser mode: converts the eBay item id to Gixen's bare numeric form and formats the max bid", async () => {
  await withEnv(BROWSER_ENV, async () => {
    const driver = fakeDriver();
    await withDriver(driver, async () => {
      const result = await addSnipe({ itemId: "v1|227034212964|0", maxBid: 27.633 });
      assert.equal(result.ok, true);
      assert.deepEqual(driver.calls.addSnipes[0], { itemId: "227034212964", maxBid: "27.63" });
    });
  });
});

test("browser mode: deleteSnipe converts the item id the same way", async () => {
  await withEnv(BROWSER_ENV, async () => {
    const driver = fakeDriver();
    await withDriver(driver, async () => {
      const result = await deleteSnipe({ itemId: "v1|9|0" });
      assert.equal(result.ok, true);
      assert.deepEqual(driver.calls.deleteSnipes[0], { itemId: "9" });
    });
  });
});

test("browser mode: reuses one logged-in session across sequential addSnipe calls", async () => {
  await withEnv(BROWSER_ENV, async () => {
    const driver = fakeDriver();
    await withDriver(driver, async () => {
      await addSnipe({ itemId: "v1|1|0", maxBid: 10 });
      await addSnipe({ itemId: "v1|2|0", maxBid: 20 });
      assert.equal(driver.calls.logins, 1);
      assert.equal(driver.calls.addSnipes.length, 2);
    });
  });
});

test("browser mode: recovers with a fresh login if the cached session dies mid-operation", async () => {
  await withEnv(BROWSER_ENV, async () => {
    // The first submitAddSnipe call fails (simulating a session that died
    // between calls); the retry after a fresh login should succeed.
    const driver = fakeDriver({ addSnipeThrows: (n) => n === 1 });
    await withDriver(driver, async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 10 });
      assert.equal(result.ok, true);
      assert.equal(driver.calls.logins, 2);
    });
  });
});

test("browser mode: never throws — resolves ok:false even if login fails repeatedly with a non-Error", async () => {
  await withEnv(BROWSER_ENV, async () => {
    const driver = fakeDriver({ loginThrows: () => true });
    await withDriver(driver, async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 10 });
      assert.deepEqual(result, { ok: false, message: "Gixen automation failed unexpectedly." });
      assert.equal(driver.calls.logins, 2, "should try once, then retry once with a fresh login, before giving up");
    });
  });
});
