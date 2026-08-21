-- 028_finder_gaucho_knives.sql missed finder_schedule_settings.category's own check constraint —
-- without this, saving a gaucho-knife automatic-scan schedule (or seeding its default row) fails
-- outright at the DB layer.
alter table public.finder_schedule_settings drop constraint if exists finder_schedule_settings_category_check;
alter table public.finder_schedule_settings add constraint finder_schedule_settings_category_check
  check (category in ('pocket_knife', 'carving_set', 'gaucho_knife'));

insert into public.finder_schedule_settings (category, enabled, frequency, run_hour, run_minute, day_of_week) values
  ('gaucho_knife', true, 'daily', 6, 0, null)
  on conflict (category) do nothing;
