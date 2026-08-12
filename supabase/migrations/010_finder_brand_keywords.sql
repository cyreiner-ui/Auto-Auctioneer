alter table public.finder_items add column if not exists notified_at timestamptz;
alter table public.finder_items add column if not exists gixen_status text;
alter table public.finder_items add column if not exists gixen_message text;
alter table public.finder_items add column if not exists gixen_sent_at timestamptz;

alter table public.finder_items drop constraint if exists finder_items_gixen_status_check;
alter table public.finder_items add constraint finder_items_gixen_status_check
  check (gixen_status is null or gixen_status in ('sent', 'failed'));

insert into public.finder_keywords (phrase) values
  ('sheffield knife lot'),
  ('sheffield made pocket knife lot'),
  ('solingen knife lot'),
  ('german made pocket knife lot'),
  ('opinel knife lot'),
  ('opinel pocket knife lot'),
  ('mossy oak knife lot'),
  ('winchester pocket knife lot'),
  ('m-tech knife lot'),
  ('gerber knife lot'),
  ('colt pocket knife lot'),
  ('browning knife lot'),
  ('remington pocket knife lot'),
  ('ozark trail knife lot'),
  ('tac force knife lot'),
  ('smith and wesson knife lot'),
  ('buck knife lot'),
  ('case knife lot'),
  ('kershaw knife lot'),
  ('spyderco knife lot'),
  ('benchmade knife lot'),
  ('victorinox knife lot'),
  ('schrade knife lot'),
  ('camillus knife lot'),
  ('old timer knife lot'),
  ('boker knife lot'),
  ('imperial knife lot')
on conflict (phrase) do nothing;
