-- Staff-editable negative-keyword filter for the pocket-knife pipeline, mirroring
-- finder_gaucho_negative_keywords (028_finder_gaucho_knives.sql). Applied as a post-fetch
-- title/description check before analyzeListingText even runs (lib/finder-core.ts's
-- brandNameList already treats bare "Frost"/"Frost Cutlery" as a trusted folding-knife brand
-- signal, which would otherwise resolve a Frost Cutlery listing straight to "qualified" on the
-- strength of that brand match alone) — a separate table from finder_keywords, since positive and
-- negative phrases serve entirely different purposes (drive a query vs. filter results already in
-- hand).
create table if not exists public.finder_pocket_knife_negative_keywords (
  id uuid primary key default gen_random_uuid(),
  phrase text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.finder_pocket_knife_negative_keywords enable row level security;

-- Frost Cutlery: a budget import brand staff don't want to source, regardless of stated count or
-- price. Substring-matched (see lib/finder-core.ts's matchesNegativeKeyword), so "frost cutlery"
-- alone already covers "Frost Cutlery Knife", "Frost Cutlery Pocket Knives Lot", etc.; the
-- no-space variant is seeded separately since a substring match wouldn't otherwise bridge it.
insert into public.finder_pocket_knife_negative_keywords (phrase) values
  ('frost cutlery'),
  ('frostcutlery')
on conflict (phrase) do nothing;
