import assert from "node:assert/strict";
import test from "node:test";
import { countKnivesWithGemini, VisionBudgetError, VisionQuotaError } from "../lib/gemini-vision.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, textResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

const GEMINI_ENV = { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-3.1-flash-lite" };
const INPUT = { title: "Lot of 10 pocket knives", description: "A lot of 10 used pocket knives.", imageUrl: "https://i.ebayimg.com/s-l500/1.jpg" };

function withFakeRpc(reserved, fn) {
  const fake = createFakeSupabase();
  fake.setRpc("reserve_finder_vision_usage", () => ({ data: { reserved }, error: null }));
  return (async () => {
    const restore = supabaseAdmin.rpc;
    supabaseAdmin.rpc = fake.rpc.bind(fake);
    try { return await fn(); } finally { supabaseAdmin.rpc = restore; }
  })();
}

const imageRoute = { test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/jpeg" } }) };
const geminiRoute = (body) => ({ test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }) });

test("throws before any call when GEMINI_API_KEY is not configured", async () => {
  await withEnv({ GEMINI_API_KEY: "" }, async () => {
    await withFetch([], async () => {
      await assert.rejects(() => countKnivesWithGemini(INPUT), /GEMINI_API_KEY is not configured/);
    });
  });
});

test("throws VisionBudgetError when the monthly reservation is refused", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(false, async () => {
      await withFetch([], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), VisionBudgetError);
      });
    });
  });
});

test("returns a parsed knife count on a successful analysis", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 10, containsFoldingKnife: true, confidence: 0.97, uncertaintyReason: "", itemCategory: "pocket_knife" })], async () => {
        const result = await countKnivesWithGemini(INPUT);
        assert.deepEqual(result, { knifeCount: 10, containsFoldingKnife: true, confidence: 0.97, uncertaintyReason: "", itemCategory: "pocket_knife" });
      });
    });
  });
});

test("round-trips a garbage item category unchanged", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 1, containsFoldingKnife: false, confidence: 0.95, uncertaintyReason: "", itemCategory: "box_cutter" })], async () => {
        const result = await countKnivesWithGemini(INPUT);
        assert.equal(result.itemCategory, "box_cutter");
      });
    });
  });
});

test("throws when Gemini returns an itemCategory outside the allowed set", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 10, containsFoldingKnife: true, confidence: 0.97, uncertaintyReason: "", itemCategory: "spoon" })], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), /invalid knife count/);
      });
    });
  });
});

test("throws VisionQuotaError on a 429 response", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, { test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => textResponse("quota exceeded", { status: 429 }) }], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), VisionQuotaError);
      });
    });
  });
});

test("throws a generic error on other non-2xx responses", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, { test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => textResponse("server error", { status: 500 }) }], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), /Gemini analysis failed \(500\)/);
      });
    });
  });
});

test("surfaces Google's actual error body on a non-2xx response, not just the bare status code", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, { test: (url) => url.includes("generativelanguage.googleapis.com"), respond: () => textResponse("Generative Language API has not been used in project 123 before or it is disabled.", { status: 403 }) }], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), /Gemini analysis failed \(403\): Generative Language API has not been used/);
      });
    });
  });
});

test("throws when Gemini returns an incomplete shape", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, geminiRoute({ knifeCount: 10 })], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), /invalid knife count/);
      });
    });
  });
});

test("throws when the listing image fails to download", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([{ test: (url) => url.includes("i.ebayimg.com"), respond: () => textResponse("not found", { status: 404 }) }], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), /Could not download listing image \(404\)/);
      });
    });
  });
});

test("throws when the listing URL is not actually an image", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([{ test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) }], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), /unsupported content type/);
      });
    });
  });
});

test("throws when the listing image is too large to analyze", async () => {
  await withEnv(GEMINI_ENV, async () => {
    await withFakeRpc(true, async () => {
      const big = new Uint8Array(5_000_001);
      await withFetch([{ test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(big, { status: 200, headers: { "content-type": "image/jpeg" } }) }], async () => {
        await assert.rejects(() => countKnivesWithGemini(INPUT), /too large to analyze/);
      });
    });
  });
});
