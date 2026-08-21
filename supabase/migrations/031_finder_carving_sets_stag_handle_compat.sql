-- Compatibility shim: migration 030 dropped carving_stag_handle in the same breath as adding
-- carving_handle_material, but the code that stops using the old boolean (PR #63) had not yet been
-- merged/deployed to production when that migration ran — the currently-deployed app still reads
-- and writes carving_stag_handle on every carving-set scan and vision call. Dropping it out from
-- under that still-running code breaks every such write with a "column does not exist" error.
-- Restore it (nullable, no backfill needed — nothing currently deployed reads historical values
-- across this boundary) until PR #63 ships and this column is no longer referenced anywhere.
alter table public.finder_items add column if not exists carving_stag_handle boolean;
