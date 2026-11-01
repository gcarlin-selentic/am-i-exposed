# Paid settlement alerts ($3/mo monitoring)

Design doc. am-i-exposed.com. Written 2026-11-01. Owner: Guillermo Carlin (Selentic).
Builds on `2026-10-31-settlements-money-wave2-design.md` (Piece 3), refined by the
owner's "option A" decision.

## Intent and why

A public, browsable list of settlements already exists: **1107 static
`/settlements/` pages** in the sitemap, the site's main organic-traffic engine.
Gating that list behind a paywall would kill the SEO that feeds the funnel. So
(owner decision 2026-11-01, "A") the list stays public, and the paid thing is not
"seeing the list" — it is the **proactive alert**.

Nobody checks 1107 cases by hand or catches a claim window before it closes. The
$3/mo value is: *we watch every open US data-breach settlement and tell you the
moment one opens that you may be able to claim, so you never miss the money.*

**What is sold, exactly (owner, 2026-11-01):** a **monitoring service**, not a
promise of money. We watch for cases where the subscriber *may* be able to claim;
if nothing comes up, that is not on us. The pitch is the idea that there is easy
money out there from these settlements and that **being informed is how you catch
it** — we keep you informed. No guaranteed amounts, ever, but lean hard into the
"you are missing free money unless someone tells you" angle. The free breach check
is the **free plus** that converts: it surfaces settlements that already paid out
for breaches the visitor is in and that they never heard about (the owner's own
case) — the regret that drives the subscribe.

North star: **traffic and paid conversions**. Every decision favors more of both;
the only hard limits are legal (no guaranteed money, official links only, the
disclaimer) and ad-platform policy on the ad creative (not the on-site pitch).

## What already exists (do not rebuild)

- `/settlements/` — 1107 public static pages (incl. open cases), built weekly by
  `tools/build-settlement-pages.py` from `data/open-settlements.json` + the
  catalogues. The SEO hook. **Unchanged by this work.**
- `data/open-settlements.json` — the scraper's weekly output; each row carries
  `visto_primero` (first-seen date) and `plazo` (claim deadline). "Newly opened"
  = `visto_primero` after the last alert.
- `supabase_alert_subscriptions.sql` — `alert_subscriptions`: `user_id`, `email`,
  `status` (Paddle's own values: trialing/active/past_due/paused/canceled),
  `provider`, `first_name`, `last_name`, `state`, `live_mode`; read-own RLS,
  one-live-per-email; a SQL helper already checks "this user has an active sub".
  **Written by the Paddle webhook at checkout.**
- `/api/alerts-config` — gates the offer to the US and returns Paddle config;
  returns `eligible:false` when Paddle is not configured, so the card stays dark.
- Email: `api/_email.js` sends via Brevo (receipts, refunds, ops alerts).
- The free money card (Wave 1) and the free anonymous breach check — unchanged.

## The feature

### 1. Monitoring signup (the $3/mo offer)
- The offer card (US-only, already wired via `/api/alerts-config` + Paddle) leads
  to the Paddle checkout, which collects **first name, last name, US state,
  email** (already in `alert_subscriptions`).
- Show the **disclaimer** at that step, both languages: data stored securely, used
  only to check whether a case of theirs comes up, never for marketing, never
  sold, includes storing which breaches their email is in, deletable on request.
  (Mockup: artifact `6BgxiDoNTSpkDL9RbDdAWf`.)

### 2. Store the subscriber's breaches (owner-approved)
- When a subscription becomes active, run a one-time HIBP breach check on the
  subscriber's email (server-side, their own account) and store the matched
  breach names against the subscription, so the alert job can flag a settlement
  that hits one of *their* breaches without re-querying HIBP each run. Covered by
  the disclaimer and the same read-own RLS. Note: open settlements rarely overlap
  with HIBP (the Wave-2 finding), so this is a bonus that fires occasionally; the
  core alert is the digest below.

### 3. The alert job (the paid value)
- A scheduled job (in the existing weekly GitHub Actions run, after the scraper
  and `cross-hibp`, or a Vercel cron that reads the data) finds settlements whose
  `visto_primero` is newer than the last alert and whose `plazo` is still open,
  and emails each active subscriber (Brevo) a short digest: "N new settlements
  opened you may be able to claim," each with company, amount (as published, "up
  to $X"), **claim-by date**, and a link to the **official** administrator site.
- Prioritize/flag within the email: ones that pay **your state**'s residents extra
  (using the stored `state`), and the rare one that matches **your breaches**.
- Dedup so a given settlement alerts a subscriber **once**. Notify + link only —
  never file, never a copycat site.

### 4. Gating
- Everything paid keys off an **active `alert_subscriptions` row** (status in
  active/trialing/past_due), via the existing SQL helper. US-only, via Paddle.

## Goals
- A $3/mo alert that reliably tells subscribers about newly-opened US data-breach
  settlements before the window closes, notify-and-link only.
- Reuse the existing subscription plumbing; add the disclaimer, the breach
  storage, and the alert job.
- Keep the public `/settlements/` SEO pages untouched.

## Non-goals
- Gating the settlements list (it stays public — that is the whole point of "A").
- Filing claims, selling data, marketing use of the PII.
- Full structured residence-eligibility matching (state is a flag, not a gate).
- Non-US settlements; non-data-breach class actions.

## Anti-goals (failure even if it works)
- Alerting someone they "qualify" when they plainly cannot — the copy says "you
  may be able to claim," never "you are owed."
- Alerting the same settlement twice, or after its window closed.
- Linking to a copycat claim site instead of the official administrator.
- Storing or using the PII/breaches for anything but the match; any marketing use.
- Shipping an alert that implies a guaranteed amount (`porPersona`/`pago_texto`
  is a maximum/range — keep "up to").

## Constraints (decided)
- US-only, via Paddle. **Paddle is not live yet** (domain approval pending), so
  the subscription cannot charge — build it ready and flip on when Paddle is live;
  test with a sandbox/test subscription meanwhile.
- PII = first name, last name, US state, email (no street address). Plus the
  subscriber's breach names. Disclaimer shown; owner runs any DDL in Supabase.
- Notify + link to the official administrator only. Conservative "may qualify".
- Both languages (English `/`, Spanish `/es/`); bump `app.js` `?v=` on JS changes.

## What is left to the builder
- Alert cadence (weekly aligned to the scraper vs a daily Vercel cron) and the
  exact "newly opened since last alert" bookkeeping (a global last-alert marker vs
  per-subscriber), with dedup so one settlement alerts once.
- Where the breach storage lives (a column/table extension) and the server flow
  that runs the one-time HIBP check on activation; the exact DDL for the owner.
- The alert email template and copy, both languages, reviewed before shipping.
- How state/breach prioritization renders in the email.
- Whether the alert job runs in GitHub Actions (same as the scraper, can commit)
  or a Vercel cron (reads served data, sends email) — and how it reads the
  subscriber list (Supabase service-role) without exposing PII.
- Excluding mis-flagged non-breach cases (e.g. Hyundai/Kia car-theft currently
  has `filtracion:true`) from both the list and the alerts.

## Decisions settled after the builder review (2026-11-01)

Owner direction: the paid product is **monitoring** (we watch for claimable
cases), **not a promise of money**; sell hard for traffic and conversions; the
free breach check is the plus that surfaces already-paid settlements the visitor
missed. Keep the "we monitor *your* cases" framing (keep storing breaches — it
sells the personalized monitoring, and surfaces a real match when one exists).

My calls (builder):
- **The alert job is a Vercel cron**, not GitHub Actions. Reading the subscriber
  list is reading PII; Vercel already holds the Supabase/Brevo/HIBP secrets and
  runs daily crons, so the PII never leaves that boundary and CI gains no new
  secret. The cron reads `data/open-settlements.json` from the deployed bundle
  (fs) and the subscriber list from Supabase (service-role).
- **Daily** cron. New cases only appear when the weekly scraper runs, so new-case
  timeliness is bound by the weekly scraper (a known limit; running the scraper
  more often is a separate cost decision). Running daily still beats a weekly-only
  alert for catching a case the day after it lands.
- **Welcome digest on activation** (all currently-open cases) + ongoing alerts on
  newly-opened ones — so a new subscriber gets value immediately, not silence.
- **Bookkeeping in Supabase** (owner runs DDL): a per-subscriber set of
  already-alerted settlement ids (dedup, one alert per case per subscriber), since
  a Vercel cron cannot write the repo.
- **Store breaches** (owner-approved, kept): captured at the Paddle webhook from
  `custom_data` (the breach names already known from the free check the buyer did),
  which costs no HIBP call; flag a newly-opened settlement that matches one of the
  subscriber's breach names when it happens (rare, but it is the strongest alert).
  **Drop the per-state flag** — the open-settlement rows carry no structured state,
  so there is nothing to match; revisit if that data ever lands.
- **Exclude mis-flagged non-breach cases** (e.g. Hyundai/Kia car-theft, currently
  `filtracion:true`) from the alerts.

## Suggested build order
1. Disclaimer at signup (copy + UI), both languages. (No Paddle needed to show it.)
2. The alert Vercel cron: welcome digest + newly-opened detection, read subscribers
   (Supabase) + `open-settlements.json`, Brevo email, Supabase dedup, "up to" copy,
   official links, non-breach exclusion. (Testable with a seeded test subscription.)
3. Capture + store subscriber breaches at the Paddle webhook; flag per-breach
   matches in the alert.
4. Flip on when Paddle is live.
