alter table public.finder_keywords add column if not exists max_cost_per_knife numeric(12,2);

alter table public.finder_keywords drop constraint if exists finder_keywords_max_cost_per_knife_check;
alter table public.finder_keywords add constraint finder_keywords_max_cost_per_knife_check
  check (max_cost_per_knife is null or max_cost_per_knife > 0);
