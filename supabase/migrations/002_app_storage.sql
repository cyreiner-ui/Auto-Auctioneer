create table if not exists public.app_listings (
  id text primary key,
  ebay_item_id text,
  ebay_url text not null,
  title text not null default '',
  description text not null default '',
  price numeric(12,2) not null default 0,
  status text not null default 'draft' check (status in ('draft','approved','completed')),
  final_price numeric(12,2),
  buyer text,
  completed_at text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_listing_images (
  id text primary key,
  listing_id text not null references public.app_listings(id) on delete cascade,
  name text not null,
  source_url text,
  storage_path text,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists app_listings_status_idx on public.app_listings(status);
create index if not exists app_listing_images_listing_idx on public.app_listing_images(listing_id);
alter table public.app_listings enable row level security;
alter table public.app_listing_images enable row level security;
insert into storage.buckets (id, name, public) values ('listing-images', 'listing-images', false) on conflict (id) do nothing;
