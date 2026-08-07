create index if not exists finder_items_dismissed_idx on public.finder_items (dismissed_at) where dismissed_at is not null;
