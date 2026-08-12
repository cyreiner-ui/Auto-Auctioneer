# Gixen auto-send

Every time the finder qualifies a new item, it's automatically added to your
Gixen account's snipe queue via Gixen's HTTP API (`lib/gixen-client.ts`) — no
click required. This removes the manual "WhatsApp it, then type it into
Gixen" step.

Gixen still does the actual sniping at auction close; this integration only
adds/removes items from Gixen's snipe list.

## What this does — and doesn't — do

- The app does **not** decide your real max bid. It sends a placeholder max
  bid (the qualifying total cost, i.e. item price + shipping) just so Gixen
  accepts the item into the queue. **You must log into Gixen and set the real
  max bid yourself before each auction closes**, same as before.
- If a send fails (bad credentials, Gixen API error, etc.), the item's card
  in `/staff/finder` shows a "Gixen send failed" badge with a "Retry Gixen"
  button.

## Setup

Set `GIXEN_USERNAME` and `GIXEN_PASSWORD` to the same eBay-linked login you
use for the Gixen web dashboard. These are used server-side only
(`lib/gixen-client.ts`) and are never sent to the browser.

## Testing

Gixen has no sandbox environment. Test against a real Gixen account, ideally
against a low-stakes eBay listing, and confirm the item appears in your
Gixen snipe list after a finder run qualifies it.
