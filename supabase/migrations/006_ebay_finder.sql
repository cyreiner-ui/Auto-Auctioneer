create table if not exists public.finder_keywords (
  id uuid primary key default gen_random_uuid(),
  phrase text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finder_keyword_not_blank check (length(trim(phrase)) > 0)
);

create table if not exists public.finder_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  trigger text not null check (trigger in ('scheduled', 'manual')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  keywords_scanned integer not null default 0,
  items_seen integer not null default 0,
  items_added integer not null default 0,
  qualified integer not null default 0,
  rejected integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.finder_items (
  ebay_item_id text primary key,
  run_id uuid references public.finder_runs(id) on delete set null,
  keyword_phrases text[] not null default '{}',
  title text not null,
  short_description text not null default '',
  ebay_url text not null,
  image_url text,
  item_price numeric(12,2) not null,
  shipping_cost numeric(12,2),
  currency text not null,
  buying_options text[] not null default '{}',
  item_end_date timestamptz,
  status text not null check (status in ('pending', 'qualified', 'rejected', 'error')),
  reason text,
  knife_count integer,
  contains_folding_knife boolean,
  confidence numeric(5,4),
  detection_source text check (detection_source is null or detection_source in ('text', 'vision')),
  total_cost numeric(12,2),
  cost_per_knife numeric(12,4),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  discovered_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint finder_positive_count check (knife_count is null or knife_count > 0)
);

create table if not exists public.finder_vision_usage (
  month text primary key,
  free_analyses integer not null default 0,
  paid_analyses integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists finder_keywords_enabled_idx on public.finder_keywords(enabled);
create index if not exists finder_runs_started_idx on public.finder_runs(started_at desc);
create index if not exists finder_items_status_idx on public.finder_items(status, next_attempt_at);
create index if not exists finder_items_discovered_idx on public.finder_items(discovered_at desc);

alter table public.finder_keywords enable row level security;
alter table public.finder_runs enable row level security;
alter table public.finder_items enable row level security;
alter table public.finder_vision_usage enable row level security;

insert into public.finder_keywords (phrase) values
  ('knife lots'),
  ('tsa confiscated knives'),
  ('pocket knife lot'),
  ('folding knife lot'),
  ('assorted pocket knives'),
  ('bulk pocket knives'),
  ('used pocket knife lot'),
  ('vintage pocket knife lot')
on conflict (phrase) do nothing;
