create type public.user_role as enum ('staff','auctioneer');
create type public.listing_status as enum ('draft','approved','completed');
create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, full_name text not null default '', role public.user_role not null, created_at timestamptz not null default now());
create table public.listings (id uuid primary key default gen_random_uuid(), ebay_item_id text not null unique, ebay_url text not null, title text not null default '', description text not null default '', starting_price_brl numeric(12,2), status public.listing_status not null default 'draft', final_sale_price_brl numeric(12,2), buyer_name text, created_by uuid not null references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), approved_at timestamptz, completed_at timestamptz, constraint positive_starting_price check (starting_price_brl is null or starting_price_brl > 0), constraint nonnegative_final_price check (final_sale_price_brl is null or final_sale_price_brl >= 0));
create table public.listing_images (id uuid primary key default gen_random_uuid(), listing_id uuid not null references public.listings(id) on delete cascade, storage_path text not null, display_order integer not null default 0, is_primary boolean not null default false, created_at timestamptz not null default now());
create unique index one_primary_image_per_listing on public.listing_images(listing_id) where is_primary;
create index listings_status_idx on public.listings(status);
alter table public.profiles enable row level security; alter table public.listings enable row level security; alter table public.listing_images enable row level security;
create or replace function public.current_role() returns public.user_role language sql stable security definer set search_path = public as $$ select role from public.profiles where id = auth.uid() $$;
create policy "profiles self read" on public.profiles for select using (id = auth.uid());
create policy "staff read all listings" on public.listings for select using (public.current_role() = 'staff' or status in ('approved','completed'));
create policy "staff create listings" on public.listings for insert with check (public.current_role() = 'staff' and created_by = auth.uid());
create policy "staff edit listings" on public.listings for update using (public.current_role() = 'staff') with check (public.current_role() = 'staff');
create policy "staff delete drafts" on public.listings for delete using (public.current_role() = 'staff' and status = 'draft');
create policy "auctioneer complete" on public.listings for update using (public.current_role() = 'auctioneer' and status = 'approved') with check (public.current_role() = 'auctioneer' and status = 'completed' and final_sale_price_brl >= 0 and buyer_name is not null and length(trim(buyer_name)) > 0);
create policy "images read visible" on public.listing_images for select using (exists (select 1 from listings where listings.id = listing_id and (public.current_role() = 'staff' or status in ('approved','completed'))));
create policy "staff manage images" on public.listing_images for all using (public.current_role() = 'staff') with check (public.current_role() = 'staff');
insert into storage.buckets (id, name, public) values ('listing-images','listing-images',false) on conflict do nothing;

