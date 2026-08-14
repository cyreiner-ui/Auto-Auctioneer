# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

Internal Next.js app ("Knife Auctions", formerly "Fio & Lâmina") for staff to source, evaluate, and prepare pocket-knife auction listings for manual WhatsApp posting to an auctioneer, plus a semi-automated eBay deal finder. The `staff` and `auctioneer` roles are enforced by Supabase Row Level Security policies, independently of the app's own UI/API checks.

## Commands

- `npm run dev` — Next.js dev server
- `npm run build` — production build
- `npm test` — runs `npm run build`, then the full suite via Node's built-in test runner
- Single test file: `node --experimental-strip-types --import ./tests/helpers/register-ts-resolve.mjs --test tests/<file>.test.mjs` (run `npm run build` first if the file is `tests/rendered-html.test.mjs`, which boots the real production server and fetches it)
- `npm run lint` — ESLint (flat config, `eslint-config-next`)
- `npm run db:generate` — Drizzle Kit codegen; currently unused, see the scaffolding note below
- `npm run scheduler:dev` / `npm run scheduler:deploy` — run/deploy the Cloudflare Worker scheduler (`wrangler`, config at `scheduler/wrangler.jsonc`)

Node >= 22.13.0 is required (`engines` in `package.json`).

## Deployment topology

Two independently deployed pieces:
1. **The Next.js app** — deployed to Vercel. All product code lives under `app/` and `lib/`.
2. **The scheduler** — a separate, minute-level Cloudflare Worker (`scheduler/index.ts`), deployed with `npm run scheduler:deploy`. It has no business logic of its own: every tick it POSTs to the deployed app's `/api/bids/run` and, if `FINDER_TICK_URL` is set, `/api/finder/tick`, authenticated with a shared secret header (`x-bid-scheduler-secret`, checked by `lib/scheduler-auth.ts`). Both sides must share the same `BID_SCHEDULER_SECRET`.

## Vestigial scaffolding — do not build on this

The repo was originally bootstrapped from a "vinext-starter"/"site-creator" template, and still carries that template's files even though **none of them run in the deployed app** (see the comment in `next.config.ts`): `vite.config.ts`, `worker/index.ts`, `build/sites-vite-plugin.ts`, `app/_sites-preview/`, `cloudflare-workers.d.ts`, `examples/d1/`, `.openai/hosting.json`. `db/schema.ts` is intentionally empty for the same reason — Drizzle (`drizzle.config.ts`, `npm run db:generate`) is wired up but not used anywhere; the real database is accessed directly through the Supabase client (`lib/supabase-admin.ts`, `lib/supabase/server.ts`), and schema changes are plain SQL files under `supabase/migrations/`, applied by hand in the Supabase SQL editor — there is no migration-runner command. **Whenever you add a new file under `supabase/migrations/`, also apply it immediately to the live Supabase project yourself** (via the Supabase MCP tools, e.g. `apply_migration`, when available in the session) instead of leaving it for the user to run by hand — otherwise the deployed app breaks with "Apply the finder database migration, then reload this page." (or the generic `relation ... does not exist` error) as soon as it queries the new table/column. `lib/openai.ts` (a Portuguese listing-generation helper) is also currently dead code; nothing imports it.

## Auth model

Two unrelated, non-overlapping schemes — don't conflate them:
- **Staff/browser requests**: a single shared `APP_STAFF_PASSWORD` gated behind an HMAC session cookie (`lib/staff-auth.ts`, `isStaffRequest`/`requireStaff`). There's no per-user login for staff; `auctioneer`-role access is separate and enforced at the Supabase RLS layer, not through this cookie.
- **Scheduler-to-app requests**: the shared-secret header checked by `lib/scheduler-auth.ts` (`isSchedulerRequest`), used only for the Cloudflare Worker's calls into `/api/bids/run` and `/api/finder/tick`.

## eBay deal finder (the active, staff-facing feature)

Entry point: `lib/finder-service.ts`, UI at `/staff/finder` (`app/staff/finder/`). Runs once daily (6am America/New_York) plus on every scheduler tick for already-pending items:

1. `startFinderRun` searches eBay's Browse API (`lib/ebay-finder.ts`) for each enabled keyword phrase (`finder_keywords` table, editable at `/staff/finder/settings`), and upserts every result into `finder_items`.
2. Each item first goes through fast regex-based title/description parsing (`lib/finder-core.ts::analyzeListingText`) to try to resolve a knife count without spending an API call. Only genuinely ambiguous listings fall through to Gemini vision (`lib/gemini-vision.ts`, called from `processPendingFinderItems`) — this ordering exists specifically for cost control (see the Gemini budget note below).
3. `calculateDeal` qualifies an item if `(price + shipping) / knifeCount <= maxCostPerKnife` (per-keyword override via `finder_keywords.max_cost_per_knife`, else the `EBAY_FINDER_MAX_PER_KNIFE` default).
4. Newly qualified items trigger one alert email (`lib/finder-notify.ts`, plain SMTP/nodemailer). Staff choose the notification mode and recipient list at `/staff/finder/settings` (`finder_notify_settings`/`finder_notify_recipients` tables, `app/api/finder/notify-settings/route.ts`): the default `auctions_only` mode emails a detailed per-item alert only for newly qualified auctions (fixed-price listings never need a Gixen bid, so they're skipped); `all_qualified` mode instead sends a count-only summary email (no item details) whenever any item newly qualifies, auction or fixed-price. `FINDER_ALERT_EMAILS` is a legacy env-var fallback used only while no recipient rows exist in the database.
5. Gixen sniping is never automatic: a staff member must type a real max bid and press "Set & Send" on `/staff/finder` before `lib/gixen-client.ts` does anything. Gixen's HTTP API is dead for this account, so `gixen-client.ts` drives Gixen's own website with a headless browser (`playwright-core` + `@sparticuz/chromium`) when `GIXEN_AUTOMATION_MODE=browser`; leaving it unset/`api` is an inert rollback switch.

Gemini vision has two spend guardrails enforced atomically in one RPC (`reserve_finder_vision_usage`) via `VisionBudgetError`/`VisionQuotaError` in `lib/finder-service.ts` — items are deferred an hour rather than the run failing when either is hit. `GEMINI_MONTHLY_ANALYSIS_LIMIT` (tracked in `finder_vision_usage`) is the hard monthly cap; `GEMINI_DAILY_ANALYSIS_LIMIT` (tracked in `finder_vision_usage_daily`, defaults to the monthly limit ÷ 30) paces usage evenly across the month so one busy week can't exhaust the whole budget and leave the rest of the month with no vision analysis at all. Both apply to free-mode and paid-mode analyses together, not just paid mode — free-mode traffic isn't actually cost-free once Google's own free-tier quota runs out, it just isn't tracked as spend by this app's `GEMINI_PAID_MODE` flag.

## Bidding feature (present but hidden)

The live eBay auto-bidding UI (`app/bidding/`, `app/api/bids/`, `app/api/ebay/`, `lib/ebay-bidding.ts`) is fully implemented but deliberately hidden behind `NEXT_PUBLIC_BIDDING_UI_ENABLED` (unset/`false` today) because the owner uses Gixen instead — read `docs/deferred-bidding/README.md` before touching this code path. `app/staff/bidding-simulator/` is an offline simulator that works without the flag.

## Testing notes

Tests use Node's built-in test runner (`node:test`), not Jest/Vitest, loaded via a custom loader (`tests/helpers/register-ts-resolve.mjs`) that lets `.test.mjs` files import `.ts` source directly. `tests/rendered-html.test.mjs` boots the actual built production server on a local port and fetches it, which is why `npm test` always builds first.
