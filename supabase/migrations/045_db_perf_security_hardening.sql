-- Cleanup surfaced by Supabase's advisor tooling (now checked as part of the Pro upgrade):
-- unindexed foreign keys, RLS policies re-evaluating auth.uid() per row, a redundant
-- permissive policy, a trigger function with a mutable search_path, and a maintenance
-- function that was publicly callable via PostgREST RPC despite only ever running from
-- pg_cron. None of this depends on plan tier -- it's Postgres/RLS hygiene -- but it's the
-- concrete, safe subset of the advisor findings worth fixing outright.

-- 1. Missing covering indexes for foreign keys (join/cascade-delete performance).
-- finder_items is the big one at 25k+ rows; the rest are small today but cheap to add.
create index if not exists bid_attempts_bid_lot_id_idx on public.bid_attempts(bid_lot_id);
create index if not exists finder_items_first_seen_run_id_idx on public.finder_items(first_seen_run_id);
create index if not exists finder_items_gaucho_matched_reference_id_idx on public.finder_items(gaucho_matched_reference_id);
create index if not exists finder_items_mate_gourd_matched_reference_id_idx on public.finder_items(mate_gourd_matched_reference_id);
create index if not exists finder_items_run_id_idx on public.finder_items(run_id);
create index if not exists listings_created_by_idx on public.listings(created_by);

-- 2. RLS policies calling auth.uid() directly get it re-evaluated per row instead of once
-- per statement. Wrapping in (select ...) lets the planner treat it as a stable subplan.
-- (Policies that only call public.current_role() aren't affected -- that function is
-- already `stable`, and the linter only flags direct auth.<fn>()/current_setting() calls.)
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read" on public.profiles for select using (id = (select auth.uid()));

drop policy if exists "staff create listings" on public.listings;
create policy "staff create listings" on public.listings for insert
  with check (public.current_role() = 'staff' and created_by = (select auth.uid()));

-- 3. listing_images had two permissive SELECT policies ("images read visible" and the
-- `for all` "staff manage images", which also covers select) -- both get evaluated on
-- every read. Split "staff manage images" into insert/update/delete so select has a
-- single policy again; "images read visible" already grants staff select access.
drop policy if exists "staff manage images" on public.listing_images;
create policy "staff insert images" on public.listing_images for insert
  with check (public.current_role() = 'staff');
create policy "staff update images" on public.listing_images for update
  using (public.current_role() = 'staff') with check (public.current_role() = 'staff');
create policy "staff delete images" on public.listing_images for delete
  using (public.current_role() = 'staff');

-- 4. Trigger function without a pinned search_path.
create or replace function public.finder_items_set_first_seen_run_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.first_seen_run_id := coalesce(new.first_seen_run_id, new.run_id);
  return new;
end;
$$;

-- 5. prune_stale_finder_items() only ever runs from the pg_cron job in
-- 043_finder_items_prune_schedule.sql (as the postgres role), but Postgres grants EXECUTE
-- on new functions to the PUBLIC pseudo-role by default -- which every role, including anon
-- and authenticated, implicitly has regardless of grants/revokes targeted at them
-- individually. That left PostgREST exposing this as an anonymously callable RPC
-- (/rest/v1/rpc/prune_stale_finder_items) that could delete rows on demand. Unlike
-- current_role(), this function isn't invoked from any RLS policy, so locking it down to
-- just the cron job's role (postgres) and service_role is safe.
revoke execute on function public.prune_stale_finder_items() from public;
grant execute on function public.prune_stale_finder_items() to postgres, service_role;
