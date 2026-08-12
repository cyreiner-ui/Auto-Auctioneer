import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";
import nodemailer from "nodemailer";
import { sendQualifiedItemsEmail } from "../lib/finder-notify.ts";
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
  FINDER_ALERT_EMAILS: "owner@example.test,partner@example.test",
};

test("skips silently when there are no items", async () => {
  const result = await sendQualifiedItemsEmail([]);
  assert.deepEqual(result, { ok: true, skipped: true });
});

test("skips (without throwing) when SMTP is not configured", async () => {
  await withEnv({ SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "", FINDER_ALERT_EMAILS: "" }, async () => {
    const result = await sendQualifiedItemsEmail([ITEM]);
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
    const result = await sendQualifiedItemsEmail([ITEM, { ...ITEM, ebay_item_id: "v1|2|0", title: "Lot of 8 Gerber Knives" }]);
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
    await sendQualifiedItemsEmail([ITEM]);
    assert.equal(calls[0].subject, "1 new pocket knife deal found");
  });
});

test("escapes HTML in the item title", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    const calls = [];
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (message) => { calls.push(message); } }));
    await sendQualifiedItemsEmail([{ ...ITEM, title: "<script>alert(1)</script> Lot of 5" }]);
    assert.doesNotMatch(calls[0].html, /<script>/);
    assert.match(calls[0].html, /&lt;script&gt;/);
  });
});

test("reports a send failure without throwing", async (t) => {
  await withEnv(SMTP_ENV, async () => {
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async () => { throw new Error("SMTP connection refused"); } }));
    const result = await sendQualifiedItemsEmail([ITEM]);
    assert.equal(result.ok, false);
    assert.equal(result.message, "SMTP connection refused");
  });
});
