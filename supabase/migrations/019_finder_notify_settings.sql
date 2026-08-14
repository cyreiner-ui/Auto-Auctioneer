create table if not exists public.finder_notify_settings (
  id boolean primary key default true,
  notify_mode text not null default 'auctions_only' check (notify_mode in ('auctions_only', 'all_qualified')),
  updated_at timestamptz not null default now(),
  constraint finder_notify_settings_singleton check (id)
);

insert into public.finder_notify_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.finder_notify_recipients (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  constraint finder_notify_recipient_valid check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

create index if not exists finder_notify_recipients_created_idx on public.finder_notify_recipients(created_at);

alter table public.finder_notify_settings enable row level security;
alter table public.finder_notify_recipients enable row level security;
