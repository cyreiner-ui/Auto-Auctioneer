# eBay pocket-knife finder

The staff finder lives at `/staff/finder`. It searches the first 500 eBay Best Match results for each enabled phrase, stores each eBay item once, and only sends textually ambiguous listings to Gemini.

## Setup

1. Apply `supabase/migrations/006_ebay_finder.sql`, `010_finder_brand_keywords.sql`, and `013_finder_items_max_bid.sql` to the existing Supabase project.
2. Set `GEMINI_API_KEY` to a key from a dedicated Google AI Studio project.
3. Keep `GEMINI_PAID_MODE=false` while using the free tier. If billing is later enabled, set it to `true`; the app stops after `GEMINI_MONTHLY_ANALYSIS_LIMIT` paid analyses in each UTC calendar month.
4. Set the deployed scheduler's `FINDER_TICK_URL` to the app's `/api/finder/tick` URL and deploy the scheduler with the same `BID_SCHEDULER_SECRET` used by the app.
5. To enable email alerts and Gixen auto-send, see the sections below.

The default search destination is ZIP 32819, the qualifying ceiling is $3.50 including shipping per knife, and the daily run starts during the 6:00 AM hour in America/New_York. A staff member can also start a scan from the finder page.

## Billing guardrail

Paid mode reserves $0.001 per vision analysis and refuses the 50,001st analysis with the default 50,000 monthly limit. Use a dedicated Google project and configure Google billing alerts at $40 and $50 as an independent safeguard.

## Free-tier rate limits

`GEMINI_BATCH_SIZE` controls how many pending items get a vision analysis per scheduler tick (once a minute), and `FINDER_PROCESS_CONCURRENCY` controls how many of them run in parallel. Google's free-tier limits vary by model and change over time — check the live numbers at https://aistudio.google.com under Rate Limits for the exact model in `GEMINI_MODEL`, rather than trusting a cached number here. As of this writing, `gemini-3.1-flash-lite`'s free tier's nominal limit is 4,000 requests/minute and 150,000 requests/day (a previous version of this doc assumed a much stricter 20 requests/minute / 500 requests/day, which is no longer accurate) — but real production traffic has hit `429`s well under that nominal RPM figure, implying Google also enforces a shorter burst-window limit the per-minute number doesn't capture. `GEMINI_BATCH_SIZE=100` and `FINDER_PROCESS_CONCURRENCY=12` finish a full batch well under the `/api/finder/tick` route's 60-second serverless timeout, while firing fewer simultaneous requests than a higher concurrency would — reducing (though not eliminating) how often a batch trips that burst limit. When a `429` does happen, the app defers the rest of that batch's vision-needing rows for `QUOTA_DEFER_MS` (currently 5 minutes, not the full hour earlier versions of this app used) rather than failing (see `VisionQuotaError` handling in `lib/finder-service.ts`) — a short window on purpose, since a burst-limit blip typically clears within minutes and the next scheduler tick fires in 60 seconds regardless.

## Brand-targeted keywords

`010_finder_brand_keywords.sql` seeds `finder_keywords` with lot-style phrases
for the brands that actually sell: Sheffield, Solingen/German-made, Opinel,
Mossy Oak, Winchester, M-Tech, Gerber, Colt, Browning, Remington, Ozark
Trail, Tac Force, Smith & Wesson, Buck, Case, Kershaw, Spyderco, Benchmade,
Victorinox, Schrade, Camillus, Old Timer, Boker, and Imperial. These use the
same $3.50-per-knife qualifying math as the original generic phrases — they
just target listings more likely to contain resold brands, so keyword
phrasing keeps the "lot"/"bulk" wording needed to clear that ceiling. Staff
can add, disable, or edit phrases anytime from `/staff/finder/settings`.

This roughly triples the keyword count (from 8 to ~34), which means a
roughly proportional increase in eBay Browse API calls per daily run — worth
watching against eBay's API rate limits.

## Email alerts

Alerts send over plain SMTP (`lib/finder-notify.ts`, via `nodemailer`) using
an existing mailbox — no separate email-provider account needed. Set:

- `SMTP_HOST` / `SMTP_PORT` — e.g. `smtp.gmail.com` / `587` for Gmail.
- `SMTP_USER` — the sending mailbox address (e.g. a Gmail address).
- `SMTP_PASSWORD` — an **app password**, not the account's login password.
  For Gmail: turn on 2-Step Verification, then create one at
  https://myaccount.google.com/apppasswords.
- `FINDER_ALERT_EMAIL_FROM` — defaults to `SMTP_USER` if unset.
- `FINDER_ALERT_EMAILS` — comma-separated recipient addresses (both staff).

When a finder run or vision pass qualifies new items, one email listing all
of them is sent to the configured recipients. If `SMTP_HOST`/`SMTP_USER`/
`SMTP_PASSWORD`/`FINDER_ALERT_EMAILS` aren't all set, email sending is
skipped silently (useful for local development).

Only auction-format qualifying items trigger this email — fixed-price (Buy
It Now) listings never need a Gixen bid, so they don't need this alert. The
email's purpose is specifically to prompt you to open `/staff/finder` and
enter a real max bid on the new auction item(s) before they close (see
`docs/gixen-integration/README.md`).
