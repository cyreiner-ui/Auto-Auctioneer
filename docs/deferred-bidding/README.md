# Deferred bidding systems

The live application currently hides all bidding interfaces because the owner is using Gixen for now.

The bidding implementation is preserved in the repository for possible future deployment:

- `app/bidding/BiddingPanel.tsx` — staff bidding queue and eBay account controls.
- `app/staff/bidding-simulator/` — staff-only offline simulator.
- `app/api/bids/` — staff and scheduler bidding APIs.
- `app/api/ebay/` — eBay account and OAuth routes.
- `lib/ebay-bidding.ts` — official Offer API execution path.
- `scheduler/` — minute-level Cloudflare scheduler.
- `supabase/migrations/004_staff_bidding.sql` and `005_manual_bid_fallback.sql` — bidding schema.

## Re-enable the interfaces

Set the Vercel environment variable `NEXT_PUBLIC_BIDDING_UI_ENABLED=true` and redeploy. Keep it unset or `false` while bidding is deferred.

Before enabling live bidding, verify the required eBay permission and review the authentication, account-security, payment, and audit requirements. The current implementation does not use browser automation or Gixen credentials.
