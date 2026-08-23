-- Tracks the outcome of the most recent alert-email send attempt so a total SMTP
-- failure (e.g. missing/invalid credentials) is visible to staff instead of silently
-- leaving every qualified item unnotified forever with no trace anywhere.
alter table public.finder_notify_settings
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error text,
  add column if not exists last_success_at timestamptz;
