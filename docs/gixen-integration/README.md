# Sending items to Gixen

Qualifying an item no longer sends anything to Gixen automatically.
Auction-format items sit on the `/staff/finder` results grid with no Gixen
action until you enter your real max bid and press "Set & Send" on that
item's card. Fixed-price (Buy It Now) items are still marked "Not an
auction" automatically at qualification time — Gixen never sees those.

Gixen still does the actual sniping at auction close; this integration only
adds/removes items from Gixen's snipe list, with the bid you actually typed
in.

## How it sends to Gixen

Gixen's HTTP API is dead for this account (every call returns `ERROR (501):
API DISABLED`), and Gixen no longer offers a self-service way to re-enable
it. `lib/gixen-client.ts` (`addSnipe`/`deleteSnipe`) now drives Gixen's own
website with a headless browser instead — logging in and filling out the
same "Add Snipe" form a staff member would use by hand.

Set `GIXEN_AUTOMATION_MODE=browser` to use this. Leaving it unset (or `api`)
keeps the old HTTP-API code path, which is dead but harmless — it just
always fails cleanly with a "not configured"/`501` message rather than doing
anything. This flag is a rollback switch: if the browser automation ever
misbehaves, flipping it back to `api` disables Gixen sending instantly, no
redeploy needed.

## What this does — and doesn't — do

- You set your real max bid directly on the item's card in `/staff/finder`
  before anything is sent — there is no placeholder bid anymore, and nothing
  reaches Gixen until you do this. The bid you enter is saved on the item
  even if the send to Gixen fails, so a failed attempt never loses what you
  typed — the card's "Retry with this bid" button resubmits it.
- Once an item shows "Sent to Gixen," the app has no way to change that
  snipe's bid in place (Gixen's driver only supports adding or deleting a
  snipe, not updating one) — correct it directly on Gixen's own site if you
  need to change the bid after a successful send.
- Gixen only snipes eBay **auctions** — a fixed-price (Buy It Now) listing has
  no bid to time, and Gixen rejects it. The finder still surfaces fixed-price
  deals (they're useful for manual purchase), but `addSnipe` is only ever
  called for items whose `buying_options` includes `AUCTION`; everything else
  is marked "Not an auction" and never reaches Gixen.

## A false positive found during live validation (2026-08-12)

The first live "Retry Gixen" test on a real qualified item reported success
(`gixen_status: "sent"`), but the item never appeared in Gixen's own "My
Snipes" list. Root cause: that item was a fixed-price listing (see above),
which Gixen's Add Snipe form silently rejects — but the rejection page still
contained the submitted item id (most likely the sticky form value), and the
old success check (`page.content().includes(itemId)` on the raw page HTML)
treated that as confirmation. Fixed two ways: (1) the auction-only filter
above stops non-auction items from ever reaching Gixen, and (2)
`submitAddSnipe` in `lib/gixen-client.ts` now confirms success by checking
for an actual snipe-list table row (`page.locator("tr", { hasText: itemId
})`), the same list-membership signal `submitDeleteSnipe` already used to
confirm removal — checking a specific table row is far harder to spoof than
scanning the whole page's HTML.

## Setup

Set `GIXEN_USERNAME` and `GIXEN_PASSWORD` to the same eBay-linked login you
use for the Gixen web dashboard. These are used server-side only
(`lib/gixen-client.ts`) and are never sent to the browser.

## Testing

Gixen has no sandbox environment, and its page markup isn't covered by
automated tests (only the driver-seam logic in `lib/gixen-client.ts` is).
Before turning on `GIXEN_AUTOMATION_MODE=browser` in production, validate it
live first: use the single-item "Retry Gixen" button on one real qualified
item in `/staff/finder` and confirm the item actually appears in Gixen's own
"My Snipes" list, before relying on this for every auction item going
forward. Since Gixen still requires you to type in a real max bid before
sending, testing this live with a deliberately low bid is low-stakes.
