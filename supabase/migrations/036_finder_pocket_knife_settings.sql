-- Moves the pocket-knife default max-cost-per-knife ceiling out of the EBAY_FINDER_MAX_PER_KNIFE
-- env var (deploy-time only) and into a staff-editable app setting, the same singleton-row pattern
-- already used by finder_notify_settings/finder_schedule_settings. Per-keyword overrides
-- (finder_keywords.max_cost_per_knife) are unaffected — this is only the fallback used when no
-- matched keyword has one.
create table if not exists public.finder_pocket_knife_settings (
  id boolean primary key default true,
  max_cost_per_knife numeric(12,2) not null default 4.00 check (max_cost_per_knife > 0),
  updated_at timestamptz not null default now(),
  constraint finder_pocket_knife_settings_singleton check (id)
);

insert into public.finder_pocket_knife_settings (id, max_cost_per_knife) values (true, 4.00) on conflict (id) do nothing;

alter table public.finder_pocket_knife_settings enable row level security;
