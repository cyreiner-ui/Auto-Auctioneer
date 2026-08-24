-- Staff asked to also target Boker Arbolito and La Movediza (well-known criollo/gaucho-knife
-- makers) alongside the existing Franz Wenk/Scholberg coverage. These must be seeded here AND
-- added to GAUCHO_KNIFE_PHRASES in lib/gaucho-knife-finder.ts — keywordCategory() in
-- lib/finder-service.ts classifies a search phrase as gaucho_knife only if it's in that hardcoded
-- list, so a phrase added through the settings UI alone (without the code-side addition) would
-- silently route its results through the pocket-knife pipeline instead.
insert into public.finder_keywords (phrase) values
  ('Boker Arbolito'),
  ('Arbolito knife'),
  ('La Movediza')
  on conflict (phrase) do nothing;
