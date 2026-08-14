-- The monthly cap alone (015) still lets a single busy week burn through the whole month's
-- budget, leaving the rest of the month with no vision analysis at all — not a cost problem
-- anymore, but a coverage problem (ambiguous listings just pile up unprocessed). This adds a
-- second, daily pacing cap alongside the monthly one, so a $X/month budget actually gets spent
-- roughly evenly across the month instead of front-loaded into the first few days.
create table if not exists public.finder_vision_usage_daily (
  day text primary key,
  analyses integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.finder_vision_usage_daily enable row level security;

-- Replaces the 015 signature: adds p_day/p_daily_limit and reports which cap (if either) refused
-- the reservation, so callers can give staff an accurate "back tomorrow" vs "back next month"
-- message instead of one generic "budget reached" for both.
drop function if exists public.reserve_finder_vision_usage(text, boolean, integer);

create or replace function public.reserve_finder_vision_usage(p_month text, p_day text, p_paid_mode boolean, p_monthly_limit integer, p_daily_limit integer)
returns table(free_analyses integer, paid_analyses integer, reserved boolean, limit_reason text)
language plpgsql
set search_path = public
as $$
declare
  v_free integer;
  v_paid integer;
  v_daily integer;
  v_reserved boolean;
  v_limit_reason text;
begin
  insert into public.finder_vision_usage as fvu (month, free_analyses, paid_analyses, updated_at)
  values (p_month, 0, 0, now())
  on conflict (month) do nothing;
  insert into public.finder_vision_usage_daily as fvd (day, analyses, updated_at)
  values (p_day, 0, now())
  on conflict (day) do nothing;

  -- Row locks make the read-then-decide-then-write below atomic across concurrent callers,
  -- without needing a rollback path if one cap passes but the other doesn't.
  select fvu.free_analyses, fvu.paid_analyses into v_free, v_paid
  from public.finder_vision_usage fvu where fvu.month = p_month for update;
  select fvd.analyses into v_daily
  from public.finder_vision_usage_daily fvd where fvd.day = p_day for update;

  if v_daily >= p_daily_limit then
    v_reserved := false;
    v_limit_reason := 'daily';
  elsif v_free + v_paid >= p_monthly_limit then
    v_reserved := false;
    v_limit_reason := 'monthly';
  else
    -- Every column reference here is qualified with its table alias. RETURNS TABLE implicitly
    -- declares free_analyses/paid_analyses as PL/pgSQL variables in this function's scope, so an
    -- unqualified "free_analyses" in the SET/RETURNING clauses below is ambiguous between that
    -- variable and the table column of the same name — confirmed live via direct RPC testing
    -- ("column reference \"free_analyses\" is ambiguous") before this was qualified.
    if p_paid_mode then
      update public.finder_vision_usage as fvu set paid_analyses = fvu.paid_analyses + 1, updated_at = now()
        where fvu.month = p_month returning fvu.free_analyses, fvu.paid_analyses into v_free, v_paid;
    else
      update public.finder_vision_usage as fvu set free_analyses = fvu.free_analyses + 1, updated_at = now()
        where fvu.month = p_month returning fvu.free_analyses, fvu.paid_analyses into v_free, v_paid;
    end if;
    update public.finder_vision_usage_daily as fvd set analyses = fvd.analyses + 1, updated_at = now() where fvd.day = p_day;
    v_reserved := true;
    v_limit_reason := null;
  end if;

  return query select v_free, v_paid, v_reserved, v_limit_reason;
end;
$$;
