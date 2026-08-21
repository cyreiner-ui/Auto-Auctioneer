-- Sheffield carving sets may also have a genuine ivory handle, not just stag/antler — distinguished
-- from imitation celluloid (which shows parallel lines/striations down the handle) by ivory's plain
-- white/cream color and, sometimes, a single lengthwise crack from natural aging. German/generic
-- sets still require stag only. This needs a 3-state material (not just accepted/rejected) so a
-- confirmed ivory handle can be told apart from a confirmed stag handle for display/audit — the old
-- boolean carving_stag_handle only ever recorded "confirmed stag" (true), "confirmed not stag"
-- (false), or "never asked" (null).
alter table public.finder_items add column if not exists carving_handle_material text check (carving_handle_material in ('stag', 'ivory', 'other'));

update public.finder_items
set carving_handle_material = case
  when carving_stag_handle = true then 'stag'
  when carving_stag_handle = false then 'other'
  else null
end
where carving_handle_material is null;

alter table public.finder_items drop column if exists carving_stag_handle;
