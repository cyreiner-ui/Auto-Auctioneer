# Gixen auto-send

Every time the finder qualifies a new item, it's automatically added to your
Gixen account's snipe queue — no click required. This removes the manual
"WhatsApp it, then type it into Gixen" step.

Gixen still does the actual sniping at auction close; this integration only
adds/removes items from Gixen's snipe list.

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

- The app does **not** decide your real max bid. It sends a placeholder max
  bid (the qualifying total cost, i.e. item price + shipping) just so Gixen
  accepts the item into the queue. **You must log into Gixen and set the real
  max bid yourself before each auction closes**, same as before.
- If a send fails (bad credentials, Gixen API error, etc.), the item's card
  in `/staff/finder` shows a "Gixen send failed" badge with a "Retry Gixen"
  button.
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
"My Snipes" list, before relying on the unattended background loop. Since
adding a snipe only ever sets a placeholder max bid (see above), this is
low-stakes — no real bid gets placed by this step alone.
