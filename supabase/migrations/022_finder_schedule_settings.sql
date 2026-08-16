-- Per-finder automatic-run schedule (see lib/finder-service.ts's getScheduleSettings /
-- lib/finder-core.ts's isScheduledRunTime). One row per finder category so pocket-knife and
-- carving-set can each be enabled/disabled and scheduled independently, unlike the shared
-- notify settings.
create table if not exists public.finder_schedule_settings (
  category text primary key check (category in ('pocket_knife', 'carving_set')),
  enabled boolean not null default true,
  frequency text not null default 'daily' check (frequency in ('daily', 'weekly')),
  run_hour smallint not null default 6 check (run_hour between 0 and 23),
  run_minute smallint not null default 0 check (run_minute between 0 and 59),
  -- 0 = Sunday .. 6 = Saturday. Only meaningful when frequency = 'weekly'.
  day_of_week smallint check (day_of_week between 0 and 6),
  updated_at timestamptz not null default now()
);

-- Seeded to match today's hardcoded behavior (daily at 6am America/New_York) so existing
-- automatic runs keep working unchanged until staff explicitly reconfigure them.
insert into public.finder_schedule_settings (category, enabled, frequency, run_hour, run_minute, day_of_week) values
  ('pocket_knife', true, 'daily', 6, 0, null),
  ('carving_set', true, 'daily', 6, 0, null)
on conflict (category) do nothing;
