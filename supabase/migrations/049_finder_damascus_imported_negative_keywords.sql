-- "No imported stuff" for the Damascus finder: its eBay searches are already limited to items
-- physically located in the US (lib/damascus-knife-finder.ts's DAMASCUS_ITEM_LOCATION_COUNTRY), and
-- these staff-editable negative keywords also drop US-located listings that say the knife itself
-- was made abroad. Toggle any of them off at /staff/finder/damascus-knives/settings.
insert into public.finder_damascus_negative_keywords (phrase) values
  ('made in pakistan'),
  ('pakistan made'),
  ('pakistani'),
  ('made in china'),
  ('made in india'),
  ('imported')
  on conflict (phrase) do nothing;
