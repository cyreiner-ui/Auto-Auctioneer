-- Rejected/error finder_items rows accumulate without bound (~1,000+/day) once a listing's daily
-- rescan stops re-touching it. That's the safe signal for "stale": as long as an eBay listing is
-- still returned by a keyword scan, refreshedRow() in lib/finder-service.ts rewrites its
-- processed_at to "now" on every re-touch (reusing the stored vision classification instead of
-- spending a fresh Gemini call) — so a row whose processed_at hasn't moved in 7 days (well past
-- the once-a-day scan cadence) means eBay has already stopped surfacing that listing, not that the
-- finder is about to re-analyze it. Scheduled here as a weekly pg_cron job (rather than folded
-- into the app's minute-level scheduler tick) so it runs independently of whether the Cloudflare
-- Worker scheduler is ticking.
create extension if not exists pg_cron;

create or replace function public.prune_stale_finder_items()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.finder_items
  where status in ('rejected', 'error')
    and processed_at < now() - interval '7 days';
$$;

select cron.schedule(
  'prune-stale-finder-items',
  '0 3 * * 0',
  $$select public.prune_stale_finder_items();$$
);
