-- Lets a manual "Run now" click be scoped to just the pocket-knife or just the carving-set
-- finder (see lib/finder-service.ts's startFinderRun `category` param). null means "unscoped" —
-- the daily automated scan stays that way, touching every keyword regardless of category.
alter table public.finder_runs add column if not exists category text
  check (category is null or category in ('pocket_knife', 'carving_set'));
