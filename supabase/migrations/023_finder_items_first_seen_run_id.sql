-- Tracks which run first discovered a finder_items row, distinct from run_id (which gets
-- reassigned to whichever run most recently re-touched the row). Lets the dashboard report
-- "N good deals among M new listings today" honestly instead of conflating newly-discovered
-- listings with days-old listings that simply still qualify.
alter table public.finder_items add column if not exists first_seen_run_id uuid references public.finder_runs(id);

-- BEFORE INSERT is sufficient: supabase's upsert(...).onConflict("ebay_item_id") compiles to
-- INSERT ... ON CONFLICT DO UPDATE SET <only the columns the app actually sent>. The app never
-- sends first_seen_run_id, so the conflict path's SET list never references it and an existing
-- row's value survives every later rescan untouched; only a genuine first insert sets it.
create or replace function public.finder_items_set_first_seen_run_id()
returns trigger as $$
begin
  new.first_seen_run_id := coalesce(new.first_seen_run_id, new.run_id);
  return new;
end;
$$ language plpgsql;

drop trigger if exists finder_items_set_first_seen_run_id on public.finder_items;
create trigger finder_items_set_first_seen_run_id
before insert on public.finder_items
for each row execute function public.finder_items_set_first_seen_run_id();

alter table public.finder_runs add column if not exists new_qualified integer not null default 0;
