import assert from "node:assert/strict";
import test from "node:test";
import { addSnipe, deleteSnipe } from "../lib/gixen-client.ts";
import { textResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

test("does not call Gixen when credentials are not configured", async (t) => {
  await withEnv({ GIXEN_USERNAME: "", GIXEN_PASSWORD: "" }, async () => {
    let called = false;
    await withFetch([{ test: () => true, respond: () => { called = true; return textResponse("OK 1 ADDED"); } }], async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 12.5 });
      assert.deepEqual(result, { ok: false, message: "Gixen credentials are not configured." });
      assert.equal(called, false);
    });
  });
});

test("sends the item id, max bid, and quantity to Gixen's API", async () => {
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

test("parses a Gixen error response as a failed result", async () => {
  await withEnv({ GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret" }, async () => {
    await withFetch([{ test: () => true, respond: () => textResponse("ERROR (211): item already ended") }], async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 5 });
      assert.equal(result.ok, false);
      assert.equal(result.message, "ERROR (211): item already ended");
    });
  });
});

test("treats a non-2xx HTTP response as a failed result", async () => {
  await withEnv({ GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret" }, async () => {
    await withFetch([{ test: () => true, respond: () => textResponse("Service unavailable", { status: 503 }) }], async () => {
      const result = await addSnipe({ itemId: "v1|1|0", maxBid: 5 });
      assert.equal(result.ok, false);
      assert.match(result.message, /Gixen request failed \(503\)/);
    });
  });
});

test("deleteSnipe sends the item id under the ditemid param", async () => {
  await withEnv({ GIXEN_USERNAME: "buyer", GIXEN_PASSWORD: "secret" }, async () => {
    let seenUrl;
    await withFetch([{ test: () => true, respond: (url) => { seenUrl = new URL(url); return textResponse("OK v1|9|0 DELETED"); } }], async () => {
      const result = await deleteSnipe({ itemId: "v1|9|0" });
      assert.equal(result.ok, true);
      assert.equal(seenUrl.searchParams.get("ditemid"), "v1|9|0");
    });
  });
});
