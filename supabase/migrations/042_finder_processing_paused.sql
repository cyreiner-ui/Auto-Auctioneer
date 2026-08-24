-- Supersedes the gaucho-only finder_gaucho_settings.processing_paused column added and then
-- reverted in this same development pass — staff want a pause toggle wired separately for each of
-- the three finder tracks (pocket_knife, carving_set, gaucho_knife), not just gaucho, so this is a
-- shared per-category table instead, matching the existing finder_schedule_settings pattern
-- (one row per category rather than three near-identical singleton tables).
alter table public.finder_gaucho_settings drop column if exists processing_paused;

create table if not exists public.finder_processing_settings (
  category text primary key check (category in ('pocket_knife', 'carving_set', 'gaucho_knife')),
  paused boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.finder_processing_settings (category, paused) values
  ('pocket_knife', false),
  ('carving_set', false),
  ('gaucho_knife', false)
  on conflict (category) do nothing;

alter table public.finder_processing_settings enable row level security;
