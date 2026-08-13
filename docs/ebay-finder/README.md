# eBay pocket-knife finder

The staff finder lives at `/staff/finder`. It searches the first 500 eBay Best Match results for each enabled phrase, stores each eBay item once, and only sends textually ambiguous listings to Moondream.

## Setup

1. Apply `supabase/migrations/006_ebay_finder.sql`, `010_finder_brand_keywords.sql`, and `013_finder_items_max_bid.sql` to the existing Supabase project.
2. Set `MOONDREAM_API_KEY` to a key from a Moondream Cloud workspace (https://moondream.ai) — no credit card is required for the free tier.
3. Keep `MOONDREAM_PAID_MODE=false` while using the free tier. If billing is later enabled, set it to `true`; the app stops after `MOONDREAM_MONTHLY_ANALYSIS_LIMIT` paid analyses in each UTC calendar month.
4. Set the deployed scheduler's `FINDER_TICK_URL` to the app's `/api/finder/tick` URL and deploy the scheduler with the same `BID_SCHEDULER_SECRET` used by the app.
5. To enable email alerts and Gixen auto-send, see the sections below.

The default search destination is ZIP 32819, the qualifying ceiling is $3.50 including shipping per knife, and the daily run starts during the 6:00 AM hour in America/New_York. A staff member can also start a scan from the finder page.

## Billing guardrail

Moondream bills per-token rather than per-analysis, so `paidAnalyses * 0.0012` (used for the `projectedMaximum` figure shown in the finder settings UI) is an approximation, not an exact spend figure — treat the `MOONDREAM_MONTHLY_ANALYSIS_LIMIT` cap as a call-count safety net rather than a literal dollar cap. Check https://moondream.ai/pricing for current per-token rates as an independent safeguard.

## Free-tier rate limits

`MOONDREAM_BATCH_SIZE` controls how many pending items get a vision analysis per scheduler tick (once a minute). Moondream's free tier allows 2 requests/second (10/second once $10+ in paid credits has been added) and roughly 5,000 requests/day — check the live numbers at https://docs.moondream.ai/pricing, since these change over time. Because `FINDER_PROCESS_CONCURRENCY` (default 8) can burst several vision calls in the same second, some calls within a batch may hit the per-second cap; those get deferred an hour rather than failing the whole batch (see `VisionQuotaError` handling in `lib/finder-service.ts`), so a few 429s during a busy tick are expected and harmless — the queue just drains over a couple of extra ticks.

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
