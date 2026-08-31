-- Fourth finder category: a specific maté gourd, identified visually rather than by count. Same
-- shape as 028_finder_gaucho_knives.sql (discovery leads with eBay's searchByImage against
-- staff-uploaded reference photos, since a positive-keyword requirement would miss listings a
-- seller titled generically — "gourd cup," "yerba mate," "mate cup" — rather than by any
-- distinctive name), but its own reference-image rows, negative-keyword table, and settings row so
-- it never shares data with the gaucho-knife pipeline. Qualification is driven purely by Gemini
-- vision comparing a candidate's photo against the reference photos — no price gate, same as
-- gaucho-knife.

alter table public.finder_items add column if not exists mate_gourd_match_confidence numeric(5,4);
alter table public.finder_items add column if not exists mate_gourd_match_notes text;

alter table public.finder_items drop constraint if exists finder_items_item_category_check;
alter table public.finder_items add constraint finder_items_item_category_check
  check (item_category is null or item_category in (
    'pocket_knife', 'swiss_army_multi_tool', 'multi_tool', 'plain_blade', 'credit_card_knife',
    'coin_knife', 'box_cutter', 'throwing_knife', 'keychain_knife', 'other', 'carving_set',
    'gaucho_knife', 'table_cutlery', 'mate_gourd'
  ));

alter table public.finder_runs drop constraint if exists finder_runs_category_check;
alter table public.finder_runs add constraint finder_runs_category_check
  check (category is null or category in ('pocket_knife', 'carving_set', 'gaucho_knife', 'mate_gourd'));

alter table public.finder_schedule_settings drop constraint if exists finder_schedule_settings_category_check;
alter table public.finder_schedule_settings add constraint finder_schedule_settings_category_check
  check (category in ('pocket_knife', 'carving_set', 'gaucho_knife', 'mate_gourd'));

insert into public.finder_schedule_settings (category, enabled, frequency, run_hour, run_minute, day_of_week) values
  ('mate_gourd', true, 'daily', 6, 0, null)
  on conflict (category) do nothing;

alter table public.finder_processing_settings drop constraint if exists finder_processing_settings_category_check;
alter table public.finder_processing_settings add constraint finder_processing_settings_category_check
  check (category in ('pocket_knife', 'carving_set', 'gaucho_knife', 'mate_gourd'));

insert into public.finder_processing_settings (category, paused) values
  ('mate_gourd', false)
  on conflict (category) do nothing;

-- finder_reference_images already exists (028) as a shared, category-tagged table for
-- staff-uploaded reference photos — just widen its check constraint rather than adding a second
-- reference-image table.
alter table public.finder_reference_images drop constraint if exists finder_reference_images_category_check;
alter table public.finder_reference_images add constraint finder_reference_images_category_check
  check (category in ('gaucho_knife', 'mate_gourd'));

alter table public.finder_items add column if not exists mate_gourd_matched_reference_id uuid
  references public.finder_reference_images(id) on delete set null;

-- Own negative-keyword table (not the gaucho-knife or pocket-knife ones) — a maté-gourd lookalike
-- filter has nothing to do with those categories' junk terms.
create table if not exists public.finder_mate_gourd_negative_keywords (
  id uuid primary key default gen_random_uuid(),
  phrase text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.finder_mate_gourd_negative_keywords enable row level security;

insert into public.finder_mate_gourd_negative_keywords (phrase) values
  ('coffee mug'),
  ('tea cup'),
  ('ceramic'),
  ('porcelain'),
  ('planter'),
  ('succulent'),
  ('candle holder'),
  ('birdhouse'),
  ('decorative gourd'),
  ('halloween'),
  ('toy'),
  ('replica'),
  ('cosplay'),
  ('plastic'),
  ('bombilla only'),
  ('straw only')
  on conflict (phrase) do nothing;

-- Staff-editable toggle for the maté-gourd finder's keyword-search supplement, mirroring
-- 041_finder_gaucho_settings.sql exactly (same singleton-row shape, no price field — there is no
-- price gate for this category).
create table if not exists public.finder_mate_gourd_settings (
  id boolean primary key default true,
  keyword_search_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint finder_mate_gourd_settings_singleton check (id)
);

insert into public.finder_mate_gourd_settings (id, keyword_search_enabled) values (true, true) on conflict (id) do nothing;

alter table public.finder_mate_gourd_settings enable row level security;

-- Supplemental keyword-search net (secondary to the image search) — same finder_keywords table
-- every other category shares.
insert into public.finder_keywords (phrase) values
  ('mate gourd'),
  ('yerba mate gourd'),
  ('mate cup gourd'),
  ('calabaza mate'),
  ('mate gourd silver'),
  ('antique mate gourd'),
  ('argentine mate gourd'),
  ('uruguayan mate gourd'),
  ('guampa'),
  ('poro mate'),
  ('mate gourd alpaca')
  on conflict (phrase) do nothing;
