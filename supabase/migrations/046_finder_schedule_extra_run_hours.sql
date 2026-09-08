-- Lets a finder_schedule_settings row fire more than once a day/week — see
-- lib/finder-core.ts's FinderScheduleSettings.extraRunHours / currentScheduledHour /
-- currentScheduledRunKeySuffix for how these combine with the existing run_hour/run_minute
-- columns (every listed hour shares the one run_minute). Empty (default) leaves every category's
-- existing once-a-day/once-a-week behavior completely unchanged.
--
-- A per-element bounds check on an array column can't be written as a plain CHECK expression
-- (Postgres rejects a subquery/unnest directly inside a CHECK constraint), hence this small
-- immutable helper function instead.
create or replace function public.finder_schedule_hours_valid(hours smallint[])
returns boolean
language sql
immutable
as $$
  select coalesce(bool_and(h between 0 and 23), true) from unnest(hours) as h;
$$;

alter table public.finder_schedule_settings
  add column if not exists extra_run_hours smallint[] not null default '{}'
  check (public.finder_schedule_hours_valid(extra_run_hours));

-- Pocket-knife specifically: staff reported the finder still not surfacing enough volume even
-- after widening search depth and adding the brand-category browse (see migrations/PRs around
-- 2026-09-07/08) — running the scan three times a day (6am/2pm/10pm America/New_York) catches
-- listings posted or nearing their end at different points in the day that a single daily scan's
-- newlyListed/endingSoonest supplemental passes would otherwise miss entirely between scans.
-- Every other category keeps its existing once-a-day schedule (extra_run_hours stays empty).
update public.finder_schedule_settings
  set extra_run_hours = array[14, 22]::smallint[]
  where category = 'pocket_knife';
