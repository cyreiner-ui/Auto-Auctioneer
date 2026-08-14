-- Carving-set finder: a separate algorithm (lib/carving-set-finder.ts) from the pocket-knife
-- pipeline, sharing only the finder_items/finder_keywords tables.
alter table public.finder_items add column if not exists carving_piece_count integer;
alter table public.finder_items add column if not exists carving_has_case boolean;
alter table public.finder_items add column if not exists carving_carbon_steel boolean;

alter table public.finder_items drop constraint if exists finder_items_item_category_check;
alter table public.finder_items add constraint finder_items_item_category_check
  check (item_category is null or item_category in ('pocket_knife', 'swiss_army_multi_tool', 'multi_tool', 'plain_blade', 'credit_card_knife', 'coin_knife', 'box_cutter', 'other', 'carving_set'));

insert into public.finder_keywords (phrase) values
  ('sheffield carving set'),
  ('german carving set')
on conflict (phrase) do nothing;
