-- Fifth finder category: Damascus-steel pocket knives, bowie knives, and kitchen/chef knives. Same
-- count-then-price model as the pocket-knife pipeline (text parsing first, Gemini vision only when
-- ambiguous), but its own pipeline (lib/damascus-knife-finder.ts), negative-keyword table, and
-- settings row, with two price tiers: kitchen/chef knives default to $6 per knife, every other
-- Damascus knife to $3. Sets/lots are prioritized (damascus_is_set).

alter table public.finder_items add column if not exists damascus_knife_type text;
alter table public.finder_items drop constraint if exists finder_items_damascus_knife_type_check;
alter table public.finder_items add constraint finder_items_damascus_knife_type_check
  check (damascus_knife_type is null or damascus_knife_type in ('pocket', 'bowie', 'kitchen', 'fixed_blade', 'mixed'));
alter table public.finder_items add column if not exists damascus_kitchen_count integer;
alter table public.finder_items add column if not exists damascus_is_set boolean;
alter table public.finder_items add column if not exists damascus_notes text;

alter table public.finder_items drop constraint if exists finder_items_item_category_check;
alter table public.finder_items add constraint finder_items_item_category_check
  check (item_category is null or item_category in (
    'pocket_knife', 'swiss_army_multi_tool', 'multi_tool', 'plain_blade', 'credit_card_knife',
    'coin_knife', 'box_cutter', 'throwing_knife', 'keychain_knife', 'other', 'carving_set',
    'gaucho_knife', 'table_cutlery', 'mate_gourd', 'damascus_knife'
  ));

-- The Damascus pending queue and dashboard both order sets first, within that category only.
create index if not exists finder_items_damascus_pending_idx
  on public.finder_items (damascus_is_set desc nulls last, discovered_at)
  where item_category = 'damascus_knife' and status = 'pending';

alter table public.finder_runs drop constraint if exists finder_runs_category_check;
alter table public.finder_runs add constraint finder_runs_category_check
  check (category is null or category in ('pocket_knife', 'carving_set', 'gaucho_knife', 'mate_gourd', 'damascus_knife'));

alter table public.finder_schedule_settings drop constraint if exists finder_schedule_settings_category_check;
alter table public.finder_schedule_settings add constraint finder_schedule_settings_category_check
  check (category in ('pocket_knife', 'carving_set', 'gaucho_knife', 'mate_gourd', 'damascus_knife'));

-- 7am rather than 6am: every other finder already scans at 6am, and one scheduler tick runs its due
-- scans back to back inside a 60-second function budget.
insert into public.finder_schedule_settings (category, enabled, frequency, run_hour, run_minute, day_of_week) values
  ('damascus_knife', true, 'daily', 7, 0, null)
  on conflict (category) do nothing;

alter table public.finder_processing_settings drop constraint if exists finder_processing_settings_category_check;
alter table public.finder_processing_settings add constraint finder_processing_settings_category_check
  check (category in ('pocket_knife', 'carving_set', 'gaucho_knife', 'mate_gourd', 'damascus_knife'));

insert into public.finder_processing_settings (category, paused) values
  ('damascus_knife', false)
  on conflict (category) do nothing;

create table if not exists public.finder_damascus_negative_keywords (
  id uuid primary key default gen_random_uuid(),
  phrase text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.finder_damascus_negative_keywords enable row level security;

-- Imitation-Damascus and non-knife wording the built-in text rules don't already catch.
insert into public.finder_damascus_negative_keywords (phrase) values
  ('damascus pattern print'),
  ('damascus finish'),
  ('damascus design'),
  ('printed pattern'),
  ('etched pattern'),
  ('wedding band'),
  ('ring size'),
  ('pendant'),
  ('bracelet'),
  ('money clip'),
  ('bottle opener'),
  ('letter opener'),
  ('scissors only'),
  ('sheath only')
  on conflict (phrase) do nothing;

create table if not exists public.finder_damascus_settings (
  id boolean primary key default true,
  max_cost_per_knife numeric(10,2) not null default 3 check (max_cost_per_knife > 0),
  kitchen_max_cost_per_knife numeric(10,2) not null default 6 check (kitchen_max_cost_per_knife > 0),
  updated_at timestamptz not null default now(),
  constraint finder_damascus_settings_singleton check (id)
);

insert into public.finder_damascus_settings (id, max_cost_per_knife, kitchen_max_cost_per_knife) values (true, 3, 6) on conflict (id) do nothing;

alter table public.finder_damascus_settings enable row level security;

-- The Damascus keyword seeds live in 048_finder_damascus_keywords.sql, applied only once the code
-- that routes "damascus" phrases to this pipeline is deployed.
