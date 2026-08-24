-- Production gaucho-knife results were dominated by visually-similar-but-unrelated ornate daggers
-- (Arabian khanjar/jambiya, Civil War-era Bowie daggers, antique European hunting daggers, and
-- silver-handled flatware/carving/dinner-knife cutlery) that Gemini vision matched against the
-- reference photo purely on shared surface traits (ornate silver handle, narrow blade, sheath).
-- Unlike "letter opener"/"silver dagger" (deliberately never added here — see
-- tests/gaucho-knife-finder.test.mjs — because sellers routinely use those exact vague phrases for
-- genuine, unrecognized gaucho/facón/criollo knives), each phrase below is instead a specific,
-- well-known *different* object's own name. A seller who doesn't recognize a criollo knife calls it
-- something vague, never one of these specific alternate identifications, so filtering on them here
-- doesn't risk hiding a genuine find the way a broader term would.
insert into public.finder_gaucho_negative_keywords (phrase) values
  ('khanjar'),
  ('jambiya'),
  ('civil war'),
  ('bowie'),
  ('cake knife'),
  ('dinner knife'),
  ('carving knife')
  on conflict (phrase) do nothing;
