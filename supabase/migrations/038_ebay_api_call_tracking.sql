-- Tracks how many requests this app sends to eBay's own API hosts each day (OAuth token
-- exchange, Browse API search/item lookups, the Buy/Offer bidding calls) so staff can see usage
-- against eBay's daily rate limit (5,000 calls/day for the Browse API — see the comment on
-- searchEbayByImage in lib/ebay-finder.ts) from the finder dashboard. Mirrors
-- finder_vision_usage_daily's day-keyed table + atomic increment RPC shape (016).
create table if not exists public.ebay_api_calls_daily (
  day text primary key,
  calls integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.ebay_api_calls_daily enable row level security;

create or replace function public.increment_ebay_api_calls(p_day text)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_calls integer;
begin
  insert into public.ebay_api_calls_daily as eac (day, calls, updated_at)
  values (p_day, 1, now())
  on conflict (day) do update set calls = eac.calls + 1, updated_at = now()
  returning eac.calls into v_calls;
  return v_calls;
end;
$$;
