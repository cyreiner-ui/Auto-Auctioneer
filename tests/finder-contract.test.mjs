import assert from "node:assert/strict";
import test from "node:test";
import { analyzeListingText, calculateDeal, finderPages, isDailyFinderHour, isShippingLookupWorthwhile, monthKey, resolveMaxCostPerKnife } from "../lib/finder-core.ts";

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

test("resolves a real-world lot title where an internal 'Knives' plural precedes the actual count", () => {
  const title = `Ozark Trail Folding lockback pocket Knives 3.25" length blade. 4 knives LOT`;
  assert.deepEqual(analyzeListingText(title), { kind: "resolved", count: 4, containsFoldingKnife: true, confidence: 0.99 });
});

test("bridges a brand name between the digit and the knife word, confirmed against real listing titles", () => {
  assert.deepEqual(analyzeListingText("4 Kershaw KNIVES   Camping Fishing    Lot JJ7"), { kind: "resolved", count: 4, containsFoldingKnife: true, confidence: 0.99 });
  assert.deepEqual(analyzeListingText("10 GERBER PARAFRAME KNIVES    Fishing Camping EXCELLENT    Loc 1714"), { kind: "resolved", count: 10, containsFoldingKnife: true, confidence: 0.99 });
  assert.deepEqual(analyzeListingText("3 ASSORTED KERSHAW KNIVES   FISHING   CAMPING TOOLS   Lot G1"), { kind: "resolved", count: 3, containsFoldingKnife: true, confidence: 0.99 });
});

test("bridges filler words on both sides of the brand name (adjectives before, model name after)", () => {
  assert.deepEqual(analyzeListingText("10 MED SIZE GERBER PARAFRAME KNIVES    Fishing Camping        Loc G411"), { kind: "resolved", count: 10, containsFoldingKnife: true, confidence: 0.99 });
  assert.deepEqual(analyzeListingText("6 LARGE GERBER PARAFRAME KNIVES    Fishing Camping EXCELLENT    Loc U135"), { kind: "resolved", count: 6, containsFoldingKnife: true, confidence: 0.99 });
});

test("does not treat a lot number before a brand name as a quantity", () => {
  assert.deepEqual(analyzeListingText("Lot 45 Buck Knife"), { kind: "vision" });
});

test("does not sum a title's stated total with a brand-anchored breakdown of that same total", () => {
  const title = "3 Knives   1 BYRD/ 2 COAST KNIVES   Airport Confiscation          LOT 508";
  assert.deepEqual(analyzeListingText(title), { kind: "resolved", count: 3, containsFoldingKnife: true, confidence: 0.99 });
});

test("trusts the title's own count over generic/reused boilerplate in the description", () => {
  const title = "3 Kershaw KNIVES   Camping Fishing    Lot 106";
  const description = "Buy Now 2 Kershaw KNIVES. picture shows the lot you will receive. Let your friends know.";
  assert.deepEqual(analyzeListingText(title, description), { kind: "resolved", count: 3, containsFoldingKnife: true, confidence: 0.99 });
});

test("accepts the common 'knifes' misspelling and the 'pk'/'pack' piece abbreviation", () => {
  assert.deepEqual(analyzeListingText("Vintage Pocket Knife Lot 25 Knifes And Multitools"), { kind: "resolved", count: 25, containsFoldingKnife: true, confidence: 0.99 });
  assert.deepEqual(analyzeListingText("Frost Cutlery Lot Green Handle Folding Pocket Knives Stainless Clip Liner 12 Pk"), { kind: "resolved", count: 12, containsFoldingKnife: true, confidence: 0.99 });
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

test("resolveMaxCostPerKnife falls back to the global default when no matched keyword has an override", () => {
  assert.equal(resolveMaxCostPerKnife(["knife lot"], new Map([["knife lot", null]]), 3.5), 3.5);
  assert.equal(resolveMaxCostPerKnife([], new Map(), 3.5), 3.5);
});

test("resolveMaxCostPerKnife takes the highest override among multiple matched keywords", () => {
  const overrides = new Map([["spyderco knife lot", 8], ["benchmade knife lot", 6], ["knife lot", null]]);
  assert.equal(resolveMaxCostPerKnife(["spyderco knife lot", "benchmade knife lot", "knife lot"], overrides, 3.5), 8);
});

test("resolveMaxCostPerKnife ignores a zero or negative override as invalid", () => {
  const overrides = new Map([["knife lot", 0], ["bad", -5]]);
  assert.equal(resolveMaxCostPerKnife(["knife lot", "bad"], overrides, 3.5), 3.5);
});

test("isShippingLookupWorthwhile allows a lookup when the price alone still leaves room to qualify", () => {
  assert.equal(isShippingLookupWorthwhile(30, 10, 3.5), true, "$3/knife before shipping could still qualify");
  assert.equal(isShippingLookupWorthwhile(35, 10, 3.5), true, "exactly at the ceiling before shipping is still worth checking");
});

test("isShippingLookupWorthwhile skips a lookup when the price alone already exceeds the ceiling", () => {
  assert.equal(isShippingLookupWorthwhile(100, 10, 3.5), false, "shipping can only add cost, so $10/knife before shipping can never qualify at $3.50");
});

test("isShippingLookupWorthwhile rejects invalid inputs", () => {
  assert.equal(isShippingLookupWorthwhile(30, 0, 3.5), false);
  assert.equal(isShippingLookupWorthwhile(NaN, 10, 3.5), false);
});
