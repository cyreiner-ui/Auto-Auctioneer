alter table public.finder_items add column if not exists max_bid numeric(12,2);

alter table public.finder_items drop constraint if exists finder_items_max_bid_check;
alter table public.finder_items add constraint finder_items_max_bid_check
  check (max_bid is null or max_bid > 0);
