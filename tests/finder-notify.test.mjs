import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";
import nodemailer from "nodemailer";
import { sendQualifiedItemsEmail, sendRunSummaryEmail } from "../lib/finder-notify.ts";
import { withEnv } from "./helpers/fake-fetch.mjs";

const ITEM = {
  ebay_item_id: "v1|1|0",
  title: "Lot of 10 Smith & Wesson Pocket Knives",
  ebay_url: "https://www.ebay.com/itm/1",
  image_url: "https://i.ebayimg.com/1.jpg",
  item_price: 30,
  shipping_cost: 5,
  total_cost: 35,
  cost_per_knife: 3.5,
  knife_count: 10,
};

const SMTP_ENV = {
  SMTP_HOST: "smtp.gmail.com",
  SMTP_PORT: "587",
  SMTP_USER: "alerts@example.test",
  SMTP_PASSWORD: "app-password",
  FINDER_ALERT_EMAIL_FROM: "alerts@example.test",
};

const RECIPIENTS = ["owner@example.test", "partner@example.test"];

test("skips silently when there are no items", async () => {
  const result = await sendQualifiedItemsEmail([], RECIPIENTS);
  assert.deepEqual(result, { ok: true, skipped: true });
});

test("skips (without throwing) when SMTP is not configured", async () => {
  await withEnv({ SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "" }, async () => {
    const result = await sendQualifiedItemsEmail([ITEM], RECIPIENTS);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.message, /not configured/);
  });
});

test("skips (without throwing) when there are no recipients", async () => {
  await withEnv(SMTP_ENV, async () => {
    const result = await sendQualifiedItemsEmail([ITEM], []);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.message, /not configured/);
  });
});

test("sends one email covering every qualifying item", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({
      sendMail: async (message) => { calls.push(message); return { messageId: "abc" }; },
    }));
    const result = await sendQualifiedItemsEmail([ITEM, { ...ITEM, ebay_item_id: "v1|2|0", title: "Lot of 8 Gerber Knives" }], RECIPIENTS);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].from, "alerts@example.test");
    assert.deepEqual(calls[0].to, ["owner@example.test", "partner@example.test"]);
    assert.equal(calls[0].subject, "2 new pocket knife deals found");
    assert.match(calls[0].html, /Lot of 10 Smith &amp; Wesson Pocket Knives/);
    assert.match(calls[0].html, /Lot of 8 Gerber Knives/);
  });
});

test("uses singular phrasing for exactly one item", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { calls.push(message); } }));
    await sendQualifiedItemsEmail([ITEM], RECIPIENTS);
    assert.equal(calls[0].subject, "1 new pocket knife deal found");
  });
});

test("escapes HTML in the item title", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { calls.push(message); } }));
    await sendQualifiedItemsEmail([{ ...ITEM, title: "<script>alert(1)</script> Lot of 5" }], RECIPIENTS);
    assert.doesNotMatch(calls[0].html, /<script>/);
    assert.match(calls[0].html, /&lt;script&gt;/);
  });
});

test("reports a send failure without throwing", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async () => { throw new Error("SMTP connection refused"); } }));
    const result = await sendQualifiedItemsEmail([ITEM], RECIPIENTS);
    assert.equal(result.ok, false);
    assert.equal(result.message, "SMTP connection refused");
  });
});

test("sendRunSummaryEmail skips silently when the count is zero", async () => {
  const result = await sendRunSummaryEmail({ total: 0, auctionCount: 0, fixedPriceCount: 0 }, RECIPIENTS);
  assert.deepEqual(result, { ok: true, skipped: true });
});

test("sendRunSummaryEmail skips (without throwing) when SMTP is not configured", async () => {
  await withEnv({ SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "" }, async () => {
    const result = await sendRunSummaryEmail({ total: 3, auctionCount: 2, fixedPriceCount: 1 }, RECIPIENTS);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.message, /not configured/);
  });
});

test("sendRunSummaryEmail sends a count-only summary, no item details", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { calls.push(message); } }));
    const result = await sendRunSummaryEmail({ total: 3, auctionCount: 2, fixedPriceCount: 1 }, RECIPIENTS);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].to, RECIPIENTS);
    assert.equal(calls[0].subject, "3 new pocket knife deals found");
    assert.match(calls[0].html, /2 auctions/);
    assert.match(calls[0].html, /1 fixed-price/);
    assert.doesNotMatch(calls[0].html, /ebay\.com/);
  });
});

test("sendRunSummaryEmail uses singular phrasing for a single result", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { calls.push(message); } }));
    await sendRunSummaryEmail({ total: 1, auctionCount: 0, fixedPriceCount: 1 }, RECIPIENTS);
    assert.equal(calls[0].subject, "1 new pocket knife deal found");
    assert.match(calls[0].html, /0 auctions/);
    assert.match(calls[0].html, /1 fixed-price/);
  });
});

test("sendRunSummaryEmail reports a send failure without throwing", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async () => { throw new Error("SMTP connection refused"); } }));
    const result = await sendRunSummaryEmail({ total: 2, auctionCount: 1, fixedPriceCount: 1 }, RECIPIENTS);
    assert.equal(result.ok, false);
    assert.equal(result.message, "SMTP connection refused");
  });
});

const CARVING_ITEM = {
  ebay_item_id: "v1|carving|0",
  title: "Antique Sheffield Carving Set",
  ebay_url: "https://www.ebay.com/itm/carving",
  image_url: "https://i.ebayimg.com/carving.jpg",
  item_price: 180,
  shipping_cost: 0,
  total_cost: 180,
  cost_per_knife: 180,
  knife_count: 1,
  carving_piece_count: 2,
  carving_has_case: true,
  carving_carbon_steel: true,
};

test("sendQualifiedItemsEmail uses a carving-set subject and detail line for kind: \"carving_set\"", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { calls.push(message); } }));
    await sendQualifiedItemsEmail([CARVING_ITEM], RECIPIENTS, "carving_set");
    assert.equal(calls[0].subject, "1 new carving set deal found");
    assert.match(calls[0].html, /2 pieces/);
    assert.match(calls[0].html, /cased/);
    assert.match(calls[0].html, /carbon steel/);
    assert.doesNotMatch(calls[0].html, /\/knife/, "the per-knife unit label doesn't apply to carving sets");
  });
});

test("sendQualifiedItemsEmail defaults to the pocket-knife subject/detail line when kind is omitted", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { calls.push(message); } }));
    await sendQualifiedItemsEmail([ITEM], RECIPIENTS);
    assert.equal(calls[0].subject, "1 new pocket knife deal found");
    assert.match(calls[0].html, /\/knife/);
  });
});

test("sendRunSummaryEmail uses a carving-set subject for kind: \"carving_set\"", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { calls.push(message); } }));
    await sendRunSummaryEmail({ total: 2, auctionCount: 1, fixedPriceCount: 1 }, RECIPIENTS, "carving_set");
    assert.equal(calls[0].subject, "2 new carving set deals found");
  });
});
