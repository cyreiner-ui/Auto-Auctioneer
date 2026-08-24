-- Staff-editable toggle for the gaucho-knife finder: whether the text keyword-search supplement
-- (GAUCHO_KNIFE_PHRASES / staff-added search terms) runs at all, alongside the primary
-- searchByImage discovery path. Same singleton-row pattern as finder_pocket_knife_settings.
-- Staff sometimes want image search only, e.g. while a keyword is producing noisy results the
-- image search + vision comparison already covers on its own.
create table if not exists public.finder_gaucho_settings (
  id boolean primary key default true,
  keyword_search_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint finder_gaucho_settings_singleton check (id)
);

insert into public.finder_gaucho_settings (id, keyword_search_enabled) values (true, true) on conflict (id) do nothing;

alter table public.finder_gaucho_settings enable row level security;
