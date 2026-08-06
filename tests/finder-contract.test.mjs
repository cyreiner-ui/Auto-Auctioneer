import assert from "node:assert/strict";
import test from "node:test";
import { analyzeListingText, calculateDeal, finderPages, isDailyFinderHour, monthKey } from "../lib/finder-core.ts";

test("extracts explicit numeric and word lot counts", () => {
  assert.deepEqual(analyzeListingText("Lot of 12 folding pocket knives"), { kind: "resolved", count: 12, containsFoldingKnife: true, confidence: 0.99 });
  assert.deepEqual(analyzeListingText("Pair pocket knives"), { kind: "resolved", count: 2, containsFoldingKnife: true, confidence: 0.99 });
  assert.deepEqual(analyzeListingText("Mixed lot: 10 folding knives and 2 kitchen knives"), { kind: "resolved", count: 12, containsFoldingKnife: true, confidence: 0.99 });
});

test("treats an unambiguous non-lot folding knife as one", () => {
  assert.deepEqual(analyzeListingText("Used folding pocket knife"), { kind: "resolved", count: 1, containsFoldingKnife: true, confidence: 0.95 });
});

test("rejects choose-one listings and sends ambiguous lots to vision", () => {
  assert.deepEqual(analyzeListingText("Choose one pocket knife from this lot"), { kind: "reject", reason: "selection_listing" });
  assert.deepEqual(analyzeListingText("TSA confiscated knives assorted lot"), { kind: "vision" });
});

test("calculates shipping-inclusive unit cost at the exact threshold", () => {
  assert.equal(calculateDeal(31, 4, 10).qualifies, true);
  assert.equal(calculateDeal(31.01, 4, 10).qualifies, false);
  assert.equal(calculateDeal(3, null, 1).reason, "missing_shipping");
});

test("uses calendar month keys and Eastern daily hour", () => {
  assert.equal(monthKey(new Date("2026-08-06T12:00:00Z")), "2026-08");
  assert.equal(isDailyFinderHour(new Date("2026-08-06T10:30:00Z")), true);
  assert.equal(isDailyFinderHour(new Date("2026-08-06T09:59:00Z")), false);
});

test("paginates 500 eBay results as 200, 200, and 100", () => {
  assert.deepEqual(finderPages(500), [{ offset: 0, limit: 200 }, { offset: 200, limit: 200 }, { offset: 400, limit: 100 }]);
});
