-- The generic carving-set catch-all keyword ('carving set', added in
-- 024_finder_carving_sets_generic_keyword.sql) turned out to be dominated on eBay by
-- wood-carving/whittling tool kits (BeaverCraft, Flexcut, etc.) rather than antique table-carving
-- cutlery. Disabled here (not deleted) so any finder_items row already discovered under it still
-- resolves to the carving-set category (lib/carving-set-finder.ts's CARVING_SET_KEYWORDS.generic
-- still recognizes the phrase) and gets re-evaluated by the new negative-keyword checks on its next
-- rescan, instead of leaking into the pocket-knife pipeline.
update public.finder_keywords set enabled = false where phrase = 'carving set';

-- Replacement: named antique English cutlery-house phrases, mirroring the brand-keyword style
-- already used for the pocket-knife pipeline (010_finder_brand_keywords.sql).
insert into public.finder_keywords (phrase) values
  ('elkington carving set'),
  ('mappin and webb carving set'),
  ('walker and hall carving set'),
  ('viners carving set'),
  ('joseph rodgers carving set'),
  ('george wostenholm carving set'),
  ('harrison brothers carving set'),
  ('wm hutton carving set')
on conflict (phrase) do nothing;

-- Persists a resolved stag/antler-handle verdict the same way carving_has_case/carving_carbon_steel
-- already do, so a later rescan doesn't have to re-spend a Gemini vision call on an
-- already-confirmed listing. Only stag/antler-handle sets qualify now, for every carving-set group.
alter table public.finder_items add column if not exists carving_stag_handle boolean;
