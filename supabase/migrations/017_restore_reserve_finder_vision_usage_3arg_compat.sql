-- Compatibility shim, applied directly to production ahead of this file landing in the repo.
--
-- Migration 016 replaced reserve_finder_vision_usage's 3-argument signature
-- (p_month, p_paid_mode, p_monthly_limit) outright with a 5-argument one that adds
-- p_day/p_daily_limit. That broke every live vision call in production, because the
-- currently-deployed app (PR #33, which introduces the 5-arg caller in lib/gemini-vision.ts,
-- had not yet merged/deployed) still calls the old 3-argument shape, and Postgres has no
-- function to resolve that call to once 016 drops it.
--
-- This restores the pre-016 3-argument function (identical to 015's monthly-cap-only logic) as
-- a second overload alongside the 5-argument one — Postgres resolves overloads by argument
-- count, so both coexist without ambiguity. The currently-deployed app keeps working unchanged
-- until PR #33 deploys; the new gemini-vision.ts then starts calling the 5-argument version with
-- daily pacing. Once that deploy is confirmed live, a follow-up migration should drop this
-- 3-argument overload — it exists only to bridge the gap between "migration applied" and
-- "app code deployed" for a single PR window, not as a permanent second call shape.
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
