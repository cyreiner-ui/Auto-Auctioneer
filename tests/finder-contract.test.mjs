import assert from "node:assert/strict";
import test from "node:test";
import { analyzeListingText, calculateDeal, effectiveMaxCostPerKnife, finderPages, isScheduledRunTime, isShippingLookupWorthwhile, monthKey, resolveMaxCostPerKnife } from "../lib/finder-core.ts";

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

test("rejects genuine per-item-price selection listings worded without choose/select", () => {
  assert.deepEqual(analyzeListingText("Pocket knife lot", "$15 each, pick your favorite"), { kind: "reject", reason: "selection_listing" });
  assert.deepEqual(analyzeListingText("Folding knife lot", "Lot of 5, each sold separately"), { kind: "reject", reason: "selection_listing" });
});

test("does not mistake routine descriptive boilerplate for a per-item selection listing", () => {
  assert.deepEqual(
    analyzeListingText("Lot of 20 Handmade Damascus Steel Pocket Folding Knife", "Each knife is individually handcrafted, so slight variations in the pattern are natural."),
    { kind: "resolved", count: 20, containsFoldingKnife: true, confidence: 0.99 },
  );
  assert.deepEqual(
    analyzeListingText("Pocket Knife Lot Of 10", "Each knife features stainless steel blades and a manual opening mechanism."),
    { kind: "resolved", count: 10, containsFoldingKnife: true, confidence: 0.99 },
  );
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

test("surfaces a title-stated lot count to vision even without a folding/brand signal, so vision only needs to confirm blade type", () => {
  assert.deepEqual(
    analyzeListingText("LOT OF 15 6inch HANDMADE DAMASCUS STEEL SKINER KNIFE USA Duty paid"),
    { kind: "vision", knownCount: 15 },
  );
  assert.deepEqual(
    analyzeListingText(`LOT OF 20 8" HANDMADE DAMASCUS STEEL HUNTING SKINER KNIFE (USA tariff Free)`),
    { kind: "vision", knownCount: 20 },
  );
});

test("does not attach a known count to vision when nothing in the text reliably states one", () => {
  assert.deepEqual(analyzeListingText("Assorted knife lot, condition varies"), { kind: "vision" });
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

test("defers a bare single-item match on an ambiguous brand (no stated count, no explicit folding wording) to vision instead of auto-approving it, since these brands are just as common on kitchen/carving cutlery", () => {
  const ambiguousBrandTitles = [
    "Case Knife", "Winchester Knife", "Colt Knife", "Remington Knife",
    "Camillus Knife", "Old Timer Knife", "Browning Knife", "Imperial Knife",
  ];
  for (const title of ambiguousBrandTitles) {
    assert.deepEqual(analyzeListingText(title), { kind: "vision" }, `"${title}" should defer to vision`);
  }
});

test("still auto-resolves a bare single-item match on a reliable brand (flagship line is folding pocket knives), unaffected by the ambiguous-brand split", () => {
  const reliableBrandTitles = ["Buck Knife", "Kershaw Knife", "Gerber Knife", "Spyderco Knife", "Benchmade Knife", "CRKT Knife", "SOG Knife"];
  for (const title of reliableBrandTitles) {
    assert.deepEqual(analyzeListingText(title), { kind: "resolved", count: 1, containsFoldingKnife: true, confidence: 0.95 }, `"${title}" should still auto-resolve`);
  }
});

test("a stated count still trusts an ambiguous brand the same as a reliable one, since a real count is stronger corroborating evidence than a bare single-item brand match", () => {
  assert.deepEqual(analyzeListingText("4 Case Knives"), { kind: "resolved", count: 4, containsFoldingKnife: true, confidence: 0.99 });
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
  assert.deepEqual(analyzeListingText(title, description), { kind: "resolved", count: 2, containsFoldingKnife: true, confidence: 0.99, swissArmy: true });
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

test("rejects table/kitchen cutlery wording outright instead of spending a vision call on it", () => {
  assert.deepEqual(analyzeListingText("Lot Of 7 Kitchen Knives Regent Sherwood/ Sheffield Tramontina Ekco Stainless"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText(`VTG Regent Sheffield England Serrated Steak Knife LOT OF 3 Bakelite Handle 8"`), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Vtg Regent Sheffield 16 Piece Set Lot Knife England 1960s Cheese Bread Serving"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Antique Mixed Silverplate Flatware Lot - Rogers Bros & Sheffield (Early 1900s)"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Vintage Wade & Butcher Sheffield England knife Holsons N.Y (lot#13288)"), { kind: "reject", reason: "non_folding_cutlery" });
});

test("does not reject cutlery wording when a folding signal is also present", () => {
  const result = analyzeListingText("Used folding pocket knife but also comes with a butter knife");
  assert.notEqual(result.kind, "reject");
});

test("rejects kitchen/table cutlery wording even when it shares a brand name with pocket knives", () => {
  assert.deepEqual(analyzeListingText("Grab Bag Lot Vintage Case Cutlery Set"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Winchester Carving Knife Set with Serving Fork"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Vintage Remington Kitchen Butcher Knife Lot"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Camillus Steak Knife Flatware Set"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Old Timer Carving Set Kitchen Cutlery"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Browning Butcher Knife Kitchen Set"), { kind: "reject", reason: "non_folding_cutlery" });
  assert.deepEqual(analyzeListingText("Imperial Kitchen Carving Knife Set"), { kind: "reject", reason: "non_folding_cutlery" });
});

test("resolves an explicit 'choose/pick/select N' stated count instead of deferring to vision", () => {
  assert.deepEqual(analyzeListingText("Pick Any 5 Pocket Knives From This Lot of 184"), { kind: "resolved", count: 5, containsFoldingKnife: true, confidence: 0.99 });
  assert.deepEqual(analyzeListingText("Select 3 Folding Knives From Our Collection"), { kind: "resolved", count: 3, containsFoldingKnife: true, confidence: 0.99 });
});

test("rejects weight-priced random grab-bag lots outright, before vision", () => {
  assert.deepEqual(
    analyzeListingText("5+ Pound Grab Bag Lot TSA Confiscated Kitchen Cutlery & Ceramic Knives 5# 5lb"),
    { kind: "reject", reason: "weight_based_lot" },
  );
  assert.deepEqual(analyzeListingText("2 lb Mystery Box of Random Folding Pocket Knives"), { kind: "reject", reason: "weight_based_lot" });
  assert.deepEqual(analyzeListingText("Pocket Knife Lot - Sold By The Pound, Random Selection"), { kind: "reject", reason: "weight_based_lot" });
});

test("does not mistake an unrelated shipping weight for a weight-based grab-bag lot", () => {
  assert.deepEqual(
    analyzeListingText("Lot of 12 folding pocket knives, 3 lb flat rate box"),
    { kind: "resolved", count: 12, containsFoldingKnife: true, confidence: 0.99 },
  );
});

test("does not reject a real knife lot that merely mentions one empty accessory", () => {
  const title = "Lot 5 Folding Knives Multi-Tool Schrade Wiss Leather Sheaths Empty EDC Reseller";
  const description = "Schrade and Wiss sheaths are empty — no knives included with sheaths. Lot of 5 knives, one multi-tool, and 3 sheaths/pouches.";
  const result = analyzeListingText(title, description);
  assert.notEqual(result.kind, "reject");
});

test("rejects box cutters, credit-card knives, coin knives, and bare replacement blades regardless of folding/brand language", () => {
  assert.deepEqual(analyzeListingText("Stanley Folding Box Cutter Utility Tool"), { kind: "reject", reason: "box_cutter" });
  assert.deepEqual(analyzeListingText("Credit Card Folding Knife Wallet Survival Tool"), { kind: "reject", reason: "credit_card_knife" });
  assert.deepEqual(analyzeListingText("Coin Shape Folding Pocket Knife Keychain"), { kind: "reject", reason: "coin_knife" });
  assert.deepEqual(analyzeListingText("Buck Knife Replacement Blade"), { kind: "reject", reason: "plain_blade" });
});

test("rejects a non-Swiss-Army multi-tool but still resolves a genuine Swiss Army multi-tool", () => {
  assert.deepEqual(analyzeListingText("Camping Folding Knife Corkscrew Bottle Opener Multi-Tool"), { kind: "reject", reason: "multi_tool" });
  assert.deepEqual(analyzeListingText("Victorinox Swiss Army Knife Corkscrew Multi-Tool"), { kind: "resolved", count: 1, containsFoldingKnife: true, confidence: 0.95, swissArmy: true });
});

test("rejects pliers-based multi-tools and bare Leatherman listings, without letting the Leatherman brand name confirm a folding signal", () => {
  assert.deepEqual(analyzeListingText("Multi-Tool With Pliers Screwdriver Knife Blade"), { kind: "reject", reason: "multi_tool" });
  assert.deepEqual(analyzeListingText("Leatherman Wave Multi-Tool Lot of 3"), { kind: "reject", reason: "multi_tool" });
  assert.deepEqual(analyzeListingText("Genuine Leatherman Pliers Tool"), { kind: "reject", reason: "multi_tool" });
});

test("rejects throwing knives regardless of stated count", () => {
  assert.deepEqual(analyzeListingText("Set of 6 Throwing Knives"), { kind: "reject", reason: "throwing_knife" });
  assert.deepEqual(analyzeListingText("Lot of 3 Knife Throwing Set with Target"), { kind: "reject", reason: "throwing_knife" });
});

test("rejects keychain/keyring knives, without needing an unrelated coin/credit-card word to catch them", () => {
  assert.deepEqual(analyzeListingText("Mini Folding Keychain Knife Lot of 10"), { kind: "reject", reason: "keychain_knife" });
  assert.deepEqual(analyzeListingText("Folding Pocket Knife Key Ring"), { kind: "reject", reason: "keychain_knife" });
});

test("effectiveMaxCostPerKnife caps Swiss Army items to the stricter ceiling, and leaves everything else alone", () => {
  assert.equal(effectiveMaxCostPerKnife("swiss_army_multi_tool", 3.5, 1.0), 1.0);
  assert.equal(effectiveMaxCostPerKnife("swiss_army_multi_tool", 0.5, 1.0), 0.5, "never raises the cap above the base max");
  assert.equal(effectiveMaxCostPerKnife("pocket_knife", 3.5, 1.0), 3.5);
  assert.equal(effectiveMaxCostPerKnife(null, 3.5, 1.0), 3.5);
  assert.equal(effectiveMaxCostPerKnife(undefined, 3.5, 1.0), 3.5);
});

test("calculates shipping-inclusive unit cost at the exact threshold", () => {
  assert.equal(calculateDeal(31, 4, 10).qualifies, true);
  assert.equal(calculateDeal(31.01, 4, 10).qualifies, false);
  assert.equal(calculateDeal(3, null, 1).reason, "missing_shipping");
});

test("uses calendar month keys", () => {
  assert.equal(monthKey(new Date("2026-08-06T12:00:00Z")), "2026-08");
});

// 2026-08-06T10:00:00Z is 06:00 America/New_York on a Thursday (weekday index 4).
const DAILY_SCHEDULE = { enabled: true, frequency: "daily", hour: 6, minute: 0, dayOfWeek: null };

test("isScheduledRunTime: daily schedule fires at or after the scheduled minute, not before", () => {
  assert.equal(isScheduledRunTime(DAILY_SCHEDULE, new Date("2026-08-06T09:59:00Z")), false, "05:59 ET is before the 06:00 schedule");
  assert.equal(isScheduledRunTime(DAILY_SCHEDULE, new Date("2026-08-06T10:00:00Z")), true, "06:00 ET is exactly the scheduled minute");
  assert.equal(isScheduledRunTime(DAILY_SCHEDULE, new Date("2026-08-06T10:30:00Z")), true, "06:30 ET is after the scheduled minute — a missed exact-minute tick shouldn't skip the whole day");
});

test("isScheduledRunTime: disabled schedule never fires", () => {
  assert.equal(isScheduledRunTime({ ...DAILY_SCHEDULE, enabled: false }, new Date("2026-08-06T10:30:00Z")), false);
});

test("isScheduledRunTime: weekly schedule only fires on the configured day of week", () => {
  const thursdaySchedule = { enabled: true, frequency: "weekly", hour: 6, minute: 0, dayOfWeek: 4 };
  assert.equal(isScheduledRunTime(thursdaySchedule, new Date("2026-08-06T10:30:00Z")), true, "2026-08-06 is a Thursday (index 4) at 06:30 ET");
  const wednesdaySchedule = { ...thursdaySchedule, dayOfWeek: 3 };
  assert.equal(isScheduledRunTime(wednesdaySchedule, new Date("2026-08-06T10:30:00Z")), false, "same time, but Thursday isn't the configured Wednesday");
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
