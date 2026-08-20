-- Two migrations were both accidentally numbered 020 (020_finder_carving_sets.sql and
-- 020_finder_items_more_item_categories.sql) and each independently dropped and recreated
-- finder_items_item_category_check from a different base list: one added 'carving_set', the other
-- added 'throwing_knife'/'keychain_knife'. Whichever ran last silently clobbered the other's
-- additions instead of the two merging, and the live constraint ended up missing
-- 'throwing_knife'/'keychain_knife' even though lib/gemini-vision.ts's ItemCategory enum (and the
-- pocket-knife vision-classification path in lib/finder-service.ts, which writes vision.itemCategory
-- straight to this column) has included both for a while. Any pocket-knife listing Gemini
-- classifies as one of those two categories fails this constraint, lands in status "error" after
-- wasting a Gemini vision call, and keeps re-wasting one on every later rescan retry.
--
-- This migration is the single authoritative list going forward — every category the application
-- code can ever write (lib/gemini-vision.ts's ItemCategory plus 'carving_set').
alter table public.finder_items drop constraint if exists finder_items_item_category_check;
alter table public.finder_items add constraint finder_items_item_category_check
  check (item_category is null or item_category in (
    'pocket_knife', 'swiss_army_multi_tool', 'multi_tool', 'plain_blade', 'credit_card_knife',
    'coin_knife', 'box_cutter', 'throwing_knife', 'keychain_knife', 'other', 'carving_set'
  ));

-- Reset the rows already stuck in "error" from this exact constraint violation so they get a
-- genuine fresh vision re-check on the next scan/tick instead of sitting permanently failed.
update public.finder_items
set status = 'pending', reason = null, attempts = 0, next_attempt_at = now()
where status = 'error' and reason like '%finder_items_item_category_check%';
