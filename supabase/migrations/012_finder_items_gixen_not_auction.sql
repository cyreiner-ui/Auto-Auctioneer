alter table public.finder_items drop constraint if exists finder_items_gixen_status_check;
alter table public.finder_items add constraint finder_items_gixen_status_check
  check (gixen_status is null or gixen_status in ('sent', 'failed', 'not_auction'));
