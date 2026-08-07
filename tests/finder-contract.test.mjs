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

test("does not mistake auction lot numbering for a knife count", () => {
  assert.deepEqual(analyzeListingText("Lot 45 folding pocket knife"), { kind: "vision" });
});

test("does not mistake a description dimension for a knife count", () => {
  assert.deepEqual(analyzeListingText("Pocket knife lot", "Blade measures 4 x 90mm overall, sheath included"), { kind: "vision" });
});

test("does not mistake a model number for a knife count", () => {
  assert.deepEqual(analyzeListingText("SOG X42 Folding Pocket Knife"), { kind: "resolved", count: 1, containsFoldingKnife: true, confidence: 0.95 });
});

test("ignores an unrelated bundled item count in the description", () => {
  assert.deepEqual(analyzeListingText("Pocket knife lot", "Includes a 4 piece cookware set plus 2 pocket knives"), { kind: "resolved", count: 2, containsFoldingKnife: true, confidence: 0.99 });
});

test("rejects an implausibly large resolved count and defers to vision", () => {
  assert.deepEqual(analyzeListingText("Lot of 999 pocket knives"), { kind: "vision" });
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
