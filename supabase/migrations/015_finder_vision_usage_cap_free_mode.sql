-- The original reserve_finder_vision_usage (007) only enforced p_monthly_limit in the
-- p_paid_mode branch — the free-mode branch always incremented free_analyses and returned
-- reserved = true no matter how high the count went. GEMINI_PAID_MODE=false was treated as
-- "Google's own free-tier rate limit will keep this near zero cost", but in production it
-- climbed past 22,000 analyses in the first two weeks of a month with almost no 429s, which
-- means real spend was happening on Google's side (or the account's quota is well above the
-- documented free-tier numbers) while this app enforced no ceiling of its own at all.
--
-- This replaces the function so p_monthly_limit applies to free_analyses + paid_analyses
-- combined, in both modes, and survives a mid-month switch between them.
create or replace function public.reserve_finder_vision_usage(p_month text, p_paid_mode boolean, p_monthly_limit integer)
returns table(free_analyses integer, paid_analyses integer, reserved boolean)
language plpgsql
set search_path = public
as $$
declare
  v_free integer;
  v_paid integer;
  v_reserved boolean;
begin
  if p_paid_mode then
    insert into public.finder_vision_usage as fvu (month, free_analyses, paid_analyses, updated_at)
    values (p_month, 0, 1, now())
    on conflict (month) do update
      set paid_analyses = fvu.paid_analyses + 1,
          updated_at = now()
      where fvu.free_analyses + fvu.paid_analyses < p_monthly_limit
    returning fvu.free_analyses, fvu.paid_analyses into v_free, v_paid;
  else
    insert into public.finder_vision_usage as fvu (month, free_analyses, paid_analyses, updated_at)
    values (p_month, 1, 0, now())
    on conflict (month) do update
      set free_analyses = fvu.free_analyses + 1,
          updated_at = now()
      where fvu.free_analyses + fvu.paid_analyses < p_monthly_limit
    returning fvu.free_analyses, fvu.paid_analyses into v_free, v_paid;
  end if;

  if found then
    v_reserved := true;
  else
    select fvu.free_analyses, fvu.paid_analyses into v_free, v_paid
    from public.finder_vision_usage fvu where fvu.month = p_month;
    v_reserved := false;
  end if;

  return query select v_free, v_paid, v_reserved;
end;
$$;
