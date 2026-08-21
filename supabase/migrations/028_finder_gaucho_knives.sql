-- Third finder category: gaucho/criollo/facón knives. Unlike pocket_knife/carving_set, discovery
-- leads with eBay's searchByImage Browse API method (staff-uploaded reference photos, see
-- finder_reference_images below) rather than keyword search, because real gaucho knives are
-- routinely mislabeled by sellers who don't recognize what they have ("letter opener," "silver
-- dagger," "ornate dagger") — a positive-keyword requirement would throw away exactly the listings
-- this feature exists to catch. Keyword search (finder_keywords, same as the other two categories)
-- is only a supplementary discovery net here. Qualification is driven purely by Gemini vision
-- comparing a candidate's photo against the reference photos — there is no price gate at launch.

alter table public.finder_items add column if not exists gaucho_match_confidence numeric(5,4);
alter table public.finder_items add column if not exists gaucho_maker_match boolean;
alter table public.finder_items add column if not exists gaucho_match_notes text;

alter table public.finder_items drop constraint if exists finder_items_item_category_check;
alter table public.finder_items add constraint finder_items_item_category_check
  check (item_category is null or item_category in (
    'pocket_knife', 'swiss_army_multi_tool', 'multi_tool', 'plain_blade', 'credit_card_knife',
    'coin_knife', 'box_cutter', 'throwing_knife', 'keychain_knife', 'other', 'carving_set', 'gaucho_knife'
  ));

alter table public.finder_runs drop constraint if exists finder_runs_category_check;
alter table public.finder_runs add constraint finder_runs_category_check
  check (category is null or category in ('pocket_knife', 'carving_set', 'gaucho_knife'));

-- Staff-uploaded reference photos of the target gaucho-knife style, driving both the searchByImage
-- discovery calls and the Gemini vision comparison prompt. category is included (even though only
-- one value is valid today) so a future category can reuse this table instead of needing its own.
create table if not exists public.finder_reference_images (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('gaucho_knife')),
  storage_path text not null,
  label text,
  created_at timestamptz not null default now()
);
create index if not exists finder_reference_images_category_idx on public.finder_reference_images(category);
alter table public.finder_reference_images enable row level security;

alter table public.finder_items add column if not exists gaucho_matched_reference_id uuid
  references public.finder_reference_images(id) on delete set null;

insert into storage.buckets (id, name, public) values ('finder-reference-images', 'finder-reference-images', false)
  on conflict (id) do nothing;

-- Staff-editable negative-keyword filter, applied as a post-fetch text check over candidates from
-- BOTH discovery paths (image search and keyword search alike) before any Gemini call — not an
-- eBay query-side "-word" exclusion like FINDER_DEFAULTS.excludeTerms, and deliberately a separate
-- table from finder_keywords rather than a flag on it, since positive and negative phrases here
-- serve entirely different purposes (drive a query vs. filter results already in hand).
create table if not exists public.finder_gaucho_negative_keywords (
  id uuid primary key default gen_random_uuid(),
  phrase text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.finder_gaucho_negative_keywords enable row level security;

insert into public.finder_keywords (phrase) values
  ('gaucho knife'),
  ('facon knife'),
  ('facón knife'),
  ('criollo knife'),
  ('cuchillo criollo'),
  ('verijero knife'),
  ('gaucho dagger'),
  ('caronero knife'),
  ('Franz Wenk'),
  ('Franz Wenk Solingen'),
  ('Scholberg'),
  ('Broqua Scholberg'),
  ('JU-CA knife'),
  ('Tandil knife'),
  ('alpaca gaucho knife'),
  ('Argentine gaucho knife')
  on conflict (phrase) do nothing;

insert into public.finder_gaucho_negative_keywords (phrase) values
  ('flatware set'),
  ('service for'),
  ('dinner fork'),
  ('soup spoon'),
  ('teaspoon'),
  ('place setting'),
  ('kitchen knife set'),
  ('chef knife'),
  ('toy'),
  ('replica'),
  ('cosplay'),
  ('costume'),
  ('plastic')
  on conflict (phrase) do nothing;
