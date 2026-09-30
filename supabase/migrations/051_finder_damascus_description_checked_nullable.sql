-- 050 declared damascus_description_checked NOT NULL, which broke every finder scan whose upsert
-- batch mixed Damascus rows (which set the column) with other finders' rows (which don't): PostgREST
-- bulk upserts fill a column missing from some rows with NULL, and the constraint rejected the whole
-- batch ("null value in column damascus_description_checked ... violates not-null constraint"), so
-- the 2026-09-30 6am pocket-knife and 7am Damascus scans saved nothing. NULL already reads as "not
-- checked yet" everywhere the column is used (see lib/finder-service.ts's processDamascusRow).
alter table public.finder_items alter column damascus_description_checked drop not null;
