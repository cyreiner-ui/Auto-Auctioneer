# Fio & Lâmina

Internal Next.js app for preparing knife auction listings and handing them to an auctioneer for manual WhatsApp posting.

## Local setup

1. Copy `.env.example` to `.env.local` and add Supabase, eBay, and OpenAI credentials.
2. Run the SQL in `supabase/migrations/001_initial.sql` in the Supabase SQL editor.
3. Create users manually in Supabase Auth, then add matching rows to `profiles` with role `staff` or `auctioneer`.
4. Run `npm run dev` and open the local URL.

The demo screen is intentionally usable without credentials for UI review. `/api/import` uses the official eBay Browse API and imports the original title and cleaned description for staff review; OpenAI is not required. Store downloaded image files under the `listing-images` private Supabase Storage bucket and issue signed URLs server-side in production.

## Deployment

Deploy the repository to Vercel, configure the variables from `.env.example`, and set the Supabase Auth site URL and redirect URL to the deployed domain. Keep `SUPABASE_SERVICE_ROLE_KEY`, eBay secrets, and `OPENAI_API_KEY` server-only. In the eBay developer portal, configure the selected keyset's Auth Accepted URL as `https://auto-auctioneer-cyreiner.vercel.app/api/ebay/oauth/callback`, then copy the environment-specific **RuName** into `EBAY_OAUTH_RUNAME` (the RuName is not the callback URL). The OAuth scopes must include eBay's public-data scope and `buy.offer.auction`. Set `EBAY_ENVIRONMENT=sandbox` for isolated eBay testing; leave it as `production` only after the account and Offer API access are approved. The free bidding scheduler is a separate Cloudflare Worker under `scheduler/`; set its `BID_SCHEDULER_SECRET` secret to the same value used by Vercel, then deploy it with `npm run scheduler:deploy`. Keep `EBAY_LIVE_BIDDING_ENABLED=false` until eBay grants production Offer API access and confirms the intended scheduling behavior is permitted.

## Tests

`npm test` runs the production build and core validation tests. The SQL policies enforce staff/auctioneer access independently of the interface.

## eBay deal finder

The staff-only pocket-knife finder searches eBay daily, calculates shipping to ZIP 32819, and uses Moondream vision only when listing text does not establish the knife count. Apply `supabase/migrations/006_ebay_finder.sql`, configure the `MOONDREAM_*` and `EBAY_FINDER_*` variables shown in `.env.example`, and point the scheduler's `FINDER_TICK_URL` at `/api/finder/tick`. See `docs/ebay-finder/README.md` for operating details.
