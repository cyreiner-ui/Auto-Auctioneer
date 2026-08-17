-- Third carving-set search phrase, generic/catch-all (lib/carving-set-finder.ts's "generic"
-- group) for cased carving sets that are neither Sheffield/English nor German-branded. Uses the
-- same case-required, piece-count-tiered pricing German sets already use.
insert into public.finder_keywords (phrase) values
  ('carving set')
on conflict (phrase) do nothing;
