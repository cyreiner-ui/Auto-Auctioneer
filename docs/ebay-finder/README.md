# eBay pocket-knife finder

The staff finder lives at `/staff/finder`. It searches the first 500 eBay Best Match results for each enabled phrase, stores each eBay item once, and only sends textually ambiguous listings to Gemini.

## Setup

1. Apply `supabase/migrations/006_ebay_finder.sql` to the existing Supabase project.
2. Set `GEMINI_API_KEY` to a key from a dedicated Google AI Studio project.
3. Keep `GEMINI_PAID_MODE=false` while using the free tier. If billing is later enabled, set it to `true`; the app stops after `GEMINI_MONTHLY_ANALYSIS_LIMIT` paid analyses in each UTC calendar month.
4. Set the deployed scheduler's `FINDER_TICK_URL` to the app's `/api/finder/tick` URL and deploy the scheduler with the same `BID_SCHEDULER_SECRET` used by the app.

The default search destination is ZIP 32819, the qualifying ceiling is $3.50 including shipping per knife, and the daily run starts during the 6:00 AM hour in America/New_York. A staff member can also start a scan from the finder page.

## Billing guardrail

Paid mode reserves $0.001 per vision analysis and refuses the 50,001st analysis with the default 50,000 monthly limit. Use a dedicated Google project and configure Google billing alerts at $40 and $50 as an independent safeguard.
