alter table public.bid_lots alter column account_id drop not null;
alter table public.bid_lots add column if not exists execution_mode text not null default 'manual';
alter table public.bid_lots drop constraint if exists bid_lots_execution_mode_check;
alter table public.bid_lots add constraint bid_lots_execution_mode_check check (execution_mode in ('manual', 'automatic'));
alter table public.bid_notifications add column if not exists acknowledged_at timestamptz;
create unique index if not exists bid_notifications_lot_kind_idx on public.bid_notifications(bid_lot_id, kind);
