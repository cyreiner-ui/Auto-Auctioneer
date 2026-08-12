# eBay pocket-knife finder

The staff finder lives at `/staff/finder`. It searches the first 500 eBay Best Match results for each enabled phrase, stores each eBay item once, and only sends textually ambiguous listings to Gemini.

## Setup

1. Apply `supabase/migrations/006_ebay_finder.sql` and `010_finder_brand_keywords.sql` to the existing Supabase project.
2. Set `GEMINI_API_KEY` to a key from a dedicated Google AI Studio project.
3. Keep `GEMINI_PAID_MODE=false` while using the free tier. If billing is later enabled, set it to `true`; the app stops after `GEMINI_MONTHLY_ANALYSIS_LIMIT` paid analyses in each UTC calendar month.
4. Set the deployed scheduler's `FINDER_TICK_URL` to the app's `/api/finder/tick` URL and deploy the scheduler with the same `BID_SCHEDULER_SECRET` used by the app.
5. To enable email alerts and Gixen auto-send, see the sections below.

The default search destination is ZIP 32819, the qualifying ceiling is $3.50 including shipping per knife, and the daily run starts during the 6:00 AM hour in America/New_York. A staff member can also start a scan from the finder page.

## Billing guardrail

Paid mode reserves $0.001 per vision analysis and refuses the 50,001st analysis with the default 50,000 monthly limit. Use a dedicated Google project and configure Google billing alerts at $40 and $50 as an independent safeguard.

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
