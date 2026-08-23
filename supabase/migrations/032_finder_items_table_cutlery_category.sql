-- Adds 'table_cutlery' to the allowed item_category values. Production data showed dinner
-- flatware/silverware lots (table knife + fork + spoon place settings, e.g. "Mixed Lot of 10 pcs
-- Oneida Silver Carlton Stainless Knife Forks Spoons") slipping past the text classifier — the
-- title never says "flatware"/"silverware"/"kitchen", just "fork"/"spoon" — and then Gemini vision
-- confirming containsFoldingKnife: true with itemCategory "other" (not a garbage category), with
-- the whole place-setting piece count counted as the knife count. That combination qualified at an
-- attractively low $/"knife". See lib/finder-core.ts's nonFoldingCutleryPattern (now also matching
-- "spoon"/"fork") and lib/gemini-vision.ts's itemCategory enum/prompt for the corresponding
-- application-code fix; table_cutlery is now in lib/finder-service.ts's GARBAGE_CATEGORIES so it's
-- rejected outright regardless of containsFoldingKnife.
alter table public.finder_items drop constraint if exists finder_items_item_category_check;
alter table public.finder_items add constraint finder_items_item_category_check
  check (item_category is null or item_category in (
    'pocket_knife', 'swiss_army_multi_tool', 'multi_tool', 'plain_blade', 'credit_card_knife',
    'coin_knife', 'box_cutter', 'throwing_knife', 'keychain_knife', 'other', 'carving_set',
    'gaucho_knife', 'table_cutlery'
  ));

-- Correct the already-misqualified flatware/silverware lots this bug produced. Confirmed none of
-- these had been emailed to staff (notified_at is null) or sent to Gixen (gixen_status
-- "not_auction" on all of them, since they're fixed-price listings) before this fix.
update public.finder_items
set status = 'rejected',
    reason = 'table_cutlery',
    item_category = 'table_cutlery',
    contains_folding_knife = false,
    processed_at = now()
where status = 'qualified'
  and item_category = 'other'
  and (title ~* '\mspoon' or title ~* '\mfork');
