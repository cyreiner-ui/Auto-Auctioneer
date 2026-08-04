# Fio & Lâmina

Internal Next.js app for preparing knife auction listings and handing them to an auctioneer for manual WhatsApp posting.

## Local setup

1. Copy `.env.example` to `.env.local` and add Supabase, eBay, and OpenAI credentials.
2. Run the SQL in `supabase/migrations/001_initial.sql` in the Supabase SQL editor.
3. Create users manually in Supabase Auth, then add matching rows to `profiles` with role `staff` or `auctioneer`.
4. Run `npm run dev` and open the local URL.

The demo screen is intentionally usable without credentials for UI review. `/api/import` uses the official eBay Browse API and imports the original title and cleaned description for staff review; OpenAI is not required. Store downloaded image files under the `listing-images` private Supabase Storage bucket and issue signed URLs server-side in production.

## Deployment

Deploy the repository to Vercel, configure the variables from `.env.example`, and set the Supabase Auth site URL and redirect URL to the deployed domain. Keep `SUPABASE_SERVICE_ROLE_KEY`, eBay secrets, and `OPENAI_API_KEY` server-only. The free bidding scheduler is a separate Cloudflare Worker under `scheduler/`; set its `BID_SCHEDULER_SECRET` secret to the same value used by Vercel, then deploy it with `npm run scheduler:deploy`. Keep `EBAY_LIVE_BIDDING_ENABLED=false` until eBay grants production Offer API access.

## Tests

`npm test` runs the production build and core validation tests. The SQL policies enforce staff/auctioneer access independently of the interface.
