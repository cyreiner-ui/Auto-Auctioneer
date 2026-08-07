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
      where fvu.paid_analyses < p_monthly_limit
    returning fvu.free_analyses, fvu.paid_analyses into v_free, v_paid;

    if found then
      v_reserved := true;
    else
      select fvu.free_analyses, fvu.paid_analyses into v_free, v_paid
      from public.finder_vision_usage fvu where fvu.month = p_month;
      v_reserved := false;
    end if;
  else
    insert into public.finder_vision_usage as fvu (month, free_analyses, paid_analyses, updated_at)
    values (p_month, 1, 0, now())
    on conflict (month) do update
      set free_analyses = fvu.free_analyses + 1,
          updated_at = now()
    returning fvu.free_analyses, fvu.paid_analyses into v_free, v_paid;
    v_reserved := true;
  end if;

  return query select v_free, v_paid, v_reserved;
end;
$$;
