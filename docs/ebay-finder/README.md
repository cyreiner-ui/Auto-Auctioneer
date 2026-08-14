# eBay pocket-knife finder

The staff finder lives at `/staff/finder`. It searches the first 500 eBay Best Match results for each enabled phrase, stores each eBay item once, and only sends textually ambiguous listings to Gemini.

## Setup

1. Apply `supabase/migrations/006_ebay_finder.sql`, `010_finder_brand_keywords.sql`, and `013_finder_items_max_bid.sql` to the existing Supabase project.
2. Set `GEMINI_API_KEY` to a key from a dedicated Google AI Studio project.
3. Keep `GEMINI_PAID_MODE=false` while using the free tier. If billing is later enabled, set it to `true`. Either way, the app stops issuing new vision analyses once `GEMINI_MONTHLY_ANALYSIS_LIMIT` is reached in a UTC calendar month — free and paid analyses count against the same shared limit, since Google can (and does) bill for calls beyond its actual free-tier quota regardless of what this flag says.
4. Set the deployed scheduler's `FINDER_TICK_URL` to the app's `/api/finder/tick` URL and deploy the scheduler with the same `BID_SCHEDULER_SECRET` used by the app.
5. To enable email alerts and Gixen auto-send, see the sections below.

The default search destination is ZIP 32819, the qualifying ceiling is $3.50 including shipping per knife, and the daily run starts during the 6:00 AM hour in America/New_York. A staff member can also start a scan from the finder page.

## Billing guardrail

Every vision analysis — free mode or paid mode — is reserved atomically against the same monthly counter (`reserve_finder_vision_usage`, `finder_vision_usage` table) and refuses the `(GEMINI_MONTHLY_ANALYSIS_LIMIT + 1)`th analysis in a UTC calendar month, at the default 10,000-analysis limit (≈$10/month at the app's conservative $0.001/analysis accounting; real per-analysis cost at current Gemini Flash-Lite pricing runs closer to $0.0003–0.0007). This used to only apply in paid mode; free-mode analyses were uncapped on the app's side under the assumption Google's own free-tier rate limit would keep it near zero cost. In practice that free-tier ceiling turned out not to actually throttle this app's traffic, so free-mode volume grew unchecked (and, since Google can bill for usage beyond its real free quota independent of this flag, that meant real spend was happening without either the per-analysis reservation or the monthly cap ever engaging). Use a dedicated Google project with Google billing alerts as an independent safeguard. Adjust `GEMINI_MONTHLY_ANALYSIS_LIMIT` if your budget target changes.

The monthly cap alone isn't enough on its own: a single busy week at this app's real volume can exhaust the whole month's budget in days, leaving the rest of the month with no vision analysis at all (ambiguous listings just pile up as `pending`). `GEMINI_DAILY_ANALYSIS_LIMIT` (default: the monthly limit ÷ 30, so 334 at the 10,000 default) enforces a second, daily pacing cap alongside the monthly one, so the budget is spent roughly evenly across the month instead of front-loaded. A deferred item's `reason` field distinguishes the two: "Daily Gemini analysis pacing cap reached; resumes tomorrow." vs. "Monthly Gemini analysis limit reached." (back next UTC month).

## Free-tier rate limits

`GEMINI_BATCH_SIZE` controls how many pending items get a vision analysis per scheduler tick (once a minute); the deployed default (`FINDER_DEFAULTS.batchSize` in `lib/finder-core.ts`) is 40, well above the 18 recommended below — if you want to stay closer to the free-tier per-minute cap, set `GEMINI_BATCH_SIZE=18` explicitly rather than relying on the code default. Google's free-tier limits vary by model and change over time — check the live numbers at https://aistudio.google.com under Rate Limits for the exact model in `GEMINI_MODEL`, rather than trusting a cached number here. As of this writing, `gemini-3.1-flash-lite`'s free tier is documented as 20 requests/minute and 500 requests/day, but don't assume that actually throttles anything: this deployment has sustained 700+ analyses/hour in free mode with almost no 429s. If you exceed the daily cap, the app defers remaining items by an hour rather than failing (see `VisionQuotaError` handling in `lib/finder-service.ts`) — but the monthly analysis cap above is what actually protects the budget now, not this rate limit.

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
