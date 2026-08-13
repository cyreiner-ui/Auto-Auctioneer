alter table public.finder_items add column if not exists shipping_source text;

alter table public.finder_items drop constraint if exists finder_items_shipping_source_check;
alter table public.finder_items add constraint finder_items_shipping_source_check
  check (shipping_source is null or shipping_source in ('listing', 'lookup'));
