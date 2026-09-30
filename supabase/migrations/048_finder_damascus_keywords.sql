-- Seeds the Damascus finder's search terms. Kept separate from 047_finder_damascus_knives.sql on
-- purpose: apply this only AFTER the app code with lib/damascus-knife-finder.ts is deployed. Before
-- that, the deployed keywordCategory doesn't know about the Damascus finder and would scan these
-- phrases as pocket-knife keywords, mixing Damascus listings into the pocket-knife dashboard/emails.
--
-- Must match DAMASCUS_KNIFE_PHRASES in lib/damascus-knife-finder.ts (any phrase containing
-- "damascus" is routed to this pipeline, so staff can add more from the settings page).
insert into public.finder_keywords (phrase) values
  ('damascus knife set'),
  ('damascus knife lot'),
  ('damascus kitchen knife set'),
  ('damascus chef knife set'),
  ('damascus steak knife set'),
  ('damascus pocket knife lot'),
  ('damascus pocket knife set'),
  ('damascus bowie knife lot'),
  ('damascus bowie knife set'),
  ('damascus pocket knife'),
  ('damascus bowie knife'),
  ('damascus chef knife'),
  ('damascus kitchen knife')
  on conflict (phrase) do nothing;
