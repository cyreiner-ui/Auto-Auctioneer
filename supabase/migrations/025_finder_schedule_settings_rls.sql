-- finder_schedule_settings was missed when RLS was enabled on the other finder tables
-- (006_ebay_finder.sql, 019_finder_notify_settings.sql). No policies needed: it's only ever
-- accessed through the service-role admin client (lib/supabase-admin.ts), which bypasses RLS.
alter table public.finder_schedule_settings enable row level security;
