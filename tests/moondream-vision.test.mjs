import assert from "node:assert/strict";
import test from "node:test";
import { countKnivesWithMoondream, VisionBudgetError, VisionQuotaError } from "../lib/moondream-vision.ts";
import { supabaseAdmin } from "../lib/supabase-admin.ts";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";
import { jsonResponse, textResponse, withEnv, withFetch } from "./helpers/fake-fetch.mjs";

const MOONDREAM_ENV = { MOONDREAM_API_KEY: "test-key", MOONDREAM_MODEL: "moondream3.1-9B-A2B" };
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
const moondreamRoute = (body) => ({ test: (url) => url.includes("api.moondream.ai"), respond: () => jsonResponse({ request_id: "req_1", answer: JSON.stringify(body) }) });

test("throws before any call when MOONDREAM_API_KEY is not configured", async () => {
  await withEnv({ MOONDREAM_API_KEY: "" }, async () => {
    await withFetch([], async () => {
      await assert.rejects(() => countKnivesWithMoondream(INPUT), /MOONDREAM_API_KEY is not configured/);
    });
  });
});

test("throws VisionBudgetError when the monthly reservation is refused", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(false, async () => {
      await withFetch([], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), VisionBudgetError);
      });
    });
  });
});

test("returns a parsed knife count on a successful analysis", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, moondreamRoute({ knifeCount: 10, containsFoldingKnife: true, confidence: 0.97, uncertaintyReason: "" })], async () => {
        const result = await countKnivesWithMoondream(INPUT);
        assert.deepEqual(result, { knifeCount: 10, containsFoldingKnife: true, confidence: 0.97, uncertaintyReason: "" });
      });
    });
  });
});

test("parses the answer even when Moondream wraps the JSON in extra prose or markdown fences", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      const wrapped = `Here you go:\n\`\`\`json\n${JSON.stringify({ knifeCount: 3, containsFoldingKnife: true, confidence: 0.92, uncertaintyReason: "" })}\n\`\`\``;
      await withFetch([imageRoute, { test: (url) => url.includes("api.moondream.ai"), respond: () => jsonResponse({ request_id: "req_1", answer: wrapped }) }], async () => {
        const result = await countKnivesWithMoondream(INPUT);
        assert.deepEqual(result, { knifeCount: 3, containsFoldingKnife: true, confidence: 0.92, uncertaintyReason: "" });
      });
    });
  });
});

test("throws VisionQuotaError on a 429 response", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, { test: (url) => url.includes("api.moondream.ai"), respond: () => textResponse("rate limited", { status: 429 }) }], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), VisionQuotaError);
      });
    });
  });
});

test("throws a generic error on other non-2xx responses", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, { test: (url) => url.includes("api.moondream.ai"), respond: () => textResponse("server error", { status: 500 }) }], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), /Moondream analysis failed \(500\)/);
      });
    });
  });
});

test("surfaces Moondream's actual error body on a non-2xx response, not just the bare status code", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, { test: (url) => url.includes("api.moondream.ai"), respond: () => textResponse("Invalid API key.", { status: 403 }) }], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), /Moondream analysis failed \(403\): Invalid API key\./);
      });
    });
  });
});

test("throws when Moondream returns an incomplete shape", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, moondreamRoute({ knifeCount: 10 })], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), /invalid knife count/);
      });
    });
  });
});

test("throws when Moondream's answer has no JSON object at all", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([imageRoute, { test: (url) => url.includes("api.moondream.ai"), respond: () => jsonResponse({ request_id: "req_1", answer: "I count ten knives." }) }], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), /invalid knife count/);
      });
    });
  });
});

test("throws when the listing image fails to download", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([{ test: (url) => url.includes("i.ebayimg.com"), respond: () => textResponse("not found", { status: 404 }) }], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), /Could not download listing image \(404\)/);
      });
    });
  });
});

test("throws when the listing URL is not actually an image", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      await withFetch([{ test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) }], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), /unsupported content type/);
      });
    });
  });
});

test("throws when the listing image is too large to analyze", async () => {
  await withEnv(MOONDREAM_ENV, async () => {
    await withFakeRpc(true, async () => {
      const big = new Uint8Array(5_000_001);
      await withFetch([{ test: (url) => url.includes("i.ebayimg.com"), respond: () => new Response(big, { status: 200, headers: { "content-type": "image/jpeg" } }) }], async () => {
        await assert.rejects(() => countKnivesWithMoondream(INPUT), /too large to analyze/);
      });
    });
  });
});
