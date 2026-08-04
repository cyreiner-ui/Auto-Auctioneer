create table if not exists public.ebay_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  ebay_username text,
  marketplace text not null default 'EBAY_US',
  status text not null default 'disconnected' check (status in ('disconnected','connected','error')),
  refresh_token_ciphertext text,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bid_lots (
  id uuid primary key default gen_random_uuid(),
  ebay_item_id text not null,
  ebay_url text not null,
  title text not null default '',
  account_id uuid not null references public.ebay_accounts(id),
  max_bid numeric(12,2) not null check (max_bid > 0),
  currency text not null default 'USD',
  all_in_budget numeric(12,2),
  auction_end_at timestamptz,
  bid_window_start timestamptz not null,
  bid_window_end timestamptz not null,
  timezone text not null default 'America/New_York',
  status text not null default 'draft' check (status in ('draft','armed','queued','submitted','outbid','won','lost','failed','cancelled')),
  armed_at timestamptz,
  claimed_at timestamptz,
  submitted_at timestamptz,
  winning_amount numeric(12,2),
  checkout_url text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bid_window_order check (bid_window_end > bid_window_start),
  constraint budget_not_below_bid check (all_in_budget is null or all_in_budget >= max_bid)
);

create table if not exists public.bid_attempts (
  id uuid primary key default gen_random_uuid(),
  bid_lot_id uuid not null references public.bid_lots(id) on delete cascade,
  idempotency_key text not null unique,
  status text not null,
  response_code integer,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists bid_lots_status_window_idx on public.bid_lots(status, bid_window_start, bid_window_end);
create index if not exists bid_lots_account_idx on public.bid_lots(account_id);
create table if not exists public.bid_notifications (
  id uuid primary key default gen_random_uuid(),
  bid_lot_id uuid references public.bid_lots(id) on delete cascade,
  kind text not null,
  message text not null,
  email_status text not null default 'pending' check (email_status in ('pending','sent','failed')),
  created_at timestamptz not null default now()
);
alter table public.ebay_accounts enable row level security;
alter table public.bid_lots enable row level security;
alter table public.bid_attempts enable row level security;
alter table public.bid_notifications enable row level security;
