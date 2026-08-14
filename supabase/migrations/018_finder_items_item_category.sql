alter table public.finder_items add column if not exists item_category text;

alter table public.finder_items drop constraint if exists finder_items_item_category_check;
alter table public.finder_items add constraint finder_items_item_category_check
  check (item_category is null or item_category in ('pocket_knife', 'swiss_army_multi_tool', 'multi_tool', 'plain_blade', 'credit_card_knife', 'coin_knife', 'box_cutter', 'other'));
