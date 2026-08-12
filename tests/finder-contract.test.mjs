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

test("does not double-count a listing that repeats its title in the description", () => {
  const title = "Lot Of 6 Pocket Knives Sheffield, Colonial, Elk Ridge, Goldblatt";
  const description = "LOT OF 6 POCKET KNIVES SHEFFIELD, COLONIAL, ELK RIDGE, GOLDBLATT. Condition is Used. Shipped with USPS Parcel Select Ground.";
  assert.deepEqual(analyzeListingText(title, description), { kind: "resolved", count: 6, containsFoldingKnife: true, confidence: 0.99 });
});

test("still sums a genuine mixed lot with distinct sub-counts split across title and description", () => {
  const title = "Mixed pocket knife lot";
  const description = "This lot includes 10 folding knives and 2 kitchen knives, all used.";
  assert.deepEqual(analyzeListingText(title, description), { kind: "resolved", count: 12, containsFoldingKnife: true, confidence: 0.99 });
});

test("does not mistake a hyphenated model code for a knife count", () => {
  const title = "New Folding Knife Lot Fox Edge Smith & Wesson Camillus 3-Piece Bundle NIB";
  const description = "Fox Edge Mandatory Fun FE-024 folding knife with an 8Cr13MoV stainless steel blade and ball bearing pivot.";
  assert.deepEqual(analyzeListingText(title, description), { kind: "resolved", count: 3, containsFoldingKnife: true, confidence: 0.99 });
});

test("does not mistake a 'No. X & Y' catalog reference for a knife count", () => {
  const title = "Opinel Wood No. 6 & 8 Folding Knife SUPER NICE!! (Lot Of 2)";
  assert.deepEqual(analyzeListingText(title), { kind: "resolved", count: 2, containsFoldingKnife: true, confidence: 0.99 });
});

test("does not fuse a trailing title number into a leading description word", () => {
  const title = "Lot of 2 Victorinox Swiss Army knives - Climber - EVO 11";
  const description = "Knives wrapped in bubble wrap. Must be 18+ to Buy.";
  assert.deepEqual(analyzeListingText(title, description), { kind: "resolved", count: 2, containsFoldingKnife: true, confidence: 0.99 });
});

test("rejects an empty-box listing outright, regardless of stated count", () => {
  assert.deepEqual(
    analyzeListingText("BUCK Knives Empty Knife Boxes Only Lot of 45", "The product is a lot of 45 empty knife boxes from Buck Knives."),
    { kind: "reject", reason: "no_knives_included" },
  );
  assert.deepEqual(
    analyzeListingText("Empty Boxes Only! Lot Of 5 Case XX Pocket Knife Black Boxes & Manuals NO KNIVES"),
    { kind: "reject", reason: "no_knives_included" },
  );
});

test("does not reject a real knife lot that merely mentions one empty accessory", () => {
  const title = "Lot 5 Folding Knives Multi-Tool Schrade Wiss Leather Sheaths Empty EDC Reseller";
  const description = "Schrade and Wiss sheaths are empty — no knives included with sheaths. Lot of 5 knives, one multi-tool, and 3 sheaths/pouches.";
  const result = analyzeListingText(title, description);
  assert.notEqual(result.kind, "reject");
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
