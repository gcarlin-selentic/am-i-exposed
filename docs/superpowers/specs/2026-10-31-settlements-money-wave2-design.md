# Wave 2 — The settlements "money" engine

Design doc. am-i-exposed.com. Written 2026-10-31. Owner: Guillermo Carlin (Selentic).

## Intent and why

am-i-exposed already tells someone, for free, whether their email is in a data
breach. Wave 1 reframed the result around **money they may be owed** from
settlements tied to those breaches. Wave 2 turns that hook into a paid business.

The north star is **payments**, not "a user claims money." The money angle is
the lever that converts the free, anonymous breach check into a paid monitoring
subscription.

The funnel is two steps:

1. **Free, anonymous (email only).** If the email is in breaches that have a US
   data-breach settlement, show the money: the "pérdidas" (what they could have
   claimed and missed — closed windows, the regret hook) and what is still open.
   Nothing about the person is stored. This is the teaser.
2. **Paid monitoring.** The visitor who does not want to miss money again
   subscribes. They give first name, last name, address, and email, behind a
   clear disclaimer: their data is stored securely, used only to check whether a
   case of theirs appears, and never for marketing. We then watch for new US
   data-breach settlements they qualify for and alert them while the claim
   window is open. We only notify and link to the official claim site; we never
   file for them and never sell their data.

## Goals

- A credible, fresh, comprehensive dataset of **US data-breach settlements**,
  open and closed, each labeled with the **origin of the breach** (ransomware vs
  ordinary breach) so the money card can separate where the money comes from.
- A free result that shows matched settlement money (open + closed) and makes the
  missed-money regret land, driving the subscribe decision.
- A paid **monitoring** product: name/last name/address/email captured under a
  disclaimer, matched against settlements, and an alert sent when a new
  qualifying case opens. Notify + official link only.
- Measured success: **paid conversions** (subscriptions started).

## Non-goals

- Non-US settlements.
- Non-data-breach class actions (purchases, products, subscriptions). Out of scope.
- Filing claims on the user's behalf. We notify and link only.
- Selling or sharing user data, or using it for marketing.
- Full structured residence-eligibility matching. Eligibility stays as the
  human-readable `elegible` text; the match is email → breach → settlement. (We
  do keep the subscriber's US state, to flag settlements that pay state residents
  an extra statutory amount — the existing behavior — which is not the same as
  full structured matching.)

## Anti-goals (failure even if it technically works)

- Promising money to users who are owed nothing. The free result must only show
  real matches and use "may qualify" language, or it erodes the trust the brand
  runs on.
- Storing the monitoring PII loosely, or ever using it for marketing. That would
  be a brand and legal disaster for a product that sells privacy.
- Routing anyone to a copycat claim site or to a closed window presented as open.
- Ad creative that says "free easy money" and gets the ad account banned.

## Constraints (decided, do not relitigate)

- Scope: US data breaches only. Open and closed settlements both shown.
- Own scraper (no bought feed).
- The free check stays 100% anonymous — no PII, ever, in that path.
- PII is captured only from paying monitoring users, with the disclaimer above,
  and used only to match them to cases. The fields are **first name, last name,
  US state, and email** — no full street address (owner decision 2026-10-31):
  the street address adds nothing to notify-and-link, and over-collecting PII is
  an anti-goal; state is kept because some settlements pay residents of certain
  states an extra statutory amount. We also store which breaches the subscriber's
  email is in (owner approved), so the monitoring job matches without re-querying
  HIBP each run; the disclaimer covers this too.
- Notify + link to the official administrator site only. Never file. Never sell.
- Only official administrator URLs. Conservative "may qualify" copy, with
  disclaimers (not lawyers, not affiliated).
- Ads advertise the free breach check, not "free money" (platform policy).
- Both languages: English at `/` (`index.html`), Spanish at `/es/index.html` —
  two parallel files, change both. Bump `app.js`'s `?v=` when `app.js` changes.

## Current state (from the pipeline review)

- **The pipeline is two disconnected halves, and the money-card file is frozen**
  (found in the builder review, confirmed in
  `.github/workflows/refresh-open-settlements.yml`):
  `refresh-open-settlements.py` scrapes classaction.org, topclassactions,
  claimdepot, FTC, JND and Kroll via Firecrawl → `data/open-settlements.json`
  (open cases, **no `hibp`**). Separately, `cross-hibp.py` builds
  `settlements.json` (the money-card file, **with `hibp`**) from
  `data/tca-settlements.json` + `data/cao-lawsuits.json` + `data/hibp-breaches.json`.
  `cross-hibp.py` never reads the scraper's output, and the producer of its
  `tca`/`cao` inputs (`refresh-cases.py`) was deleted with nothing regenerating
  it. So `settlements.json` is frozen at an October snapshot; fresh scraped cases
  reach only the static `/settlements/` pages, not the money card. Repairing this
  is the real foundation work (Piece 1).
- `settlements.json` schema per row: `hibp` (the HIBP breach name, the match
  key), `titulo`, `empresa`, `tipo` (`acuerdo`/other), `fuente`, `slug`,
  `porPersona`, `fondo`, `plazo` (ISO deadline), `sitio` (official claim site),
  `elegible` (free text). Top level: `casos`, `acuerdos`, `abiertas`, `filas`.
  **22 rows today.** Open and closed coexist (Yahoo, closed 2020, is present).
- Matching: `missedSettlements()` in `app.js` matches `s.hibp` against the user's
  breach names, email-only, anonymous. Wave 1's money card renders these.
- `tools/_radar.py` already classifies Daily Hack victims as ransomware vs data
  leak (in `radar.json`), separate from settlements.
- Alerts: `api/alerts-config.js` offers the subscription US-only, $3/mo via
  Paddle. **Paddle is not live** (pending domain approval), so the card is dark.
- PII is deliberately not stored today (`api/account-sync.js` says so). The
  `purchases` table has no name/address columns. Capturing them is net-new.

## The three pieces to build

### 1. Dataset: origin + comprehensiveness + freshness

- **Repair the pipeline first:** make the scraper's fresh, verified output flow
  into the `hibp`-matched money-card file (`settlements.json`) — rebuild the
  deleted producer step, or teach `cross-hibp.py` to consume the scraper's cases
  and match them to HIBP breach names. Without this the money card can never be
  fresh, whatever else we add.
- Add an **`origen`** field to each settlement row: `ransomware` or `brecha`
  (ordinary). Determined by the scraper's own context and/or by cross-referencing
  the Daily Hack radar's ransomware classification for the same company. Default
  when unknown: `brecha`.
- Make the scraper **comprehensive** (today it yields 22). More coverage of US
  data-breach settlements from the existing allowlisted sources.
- Keep **open and closed** without losing closed history across refreshes (a
  refresh must not drop a settlement just because its window closed).
- Run on a **cron**, like the Daily Hack refresh.

### 2. Free money card (mostly Wave 1, extended)

- Already renders matched settlements under the verdict. Add the **origin label**
  (ransomware / breach) per item, and surface the **total "pérdidas"** (missed
  money across closed matches) as the regret hook that drives subscribing.

### 3. Paid monitoring with PII + disclaimer

- Capture **first name, last name, US state, email** (no street address). The
  existing `supabase_alert_subscriptions.sql` already holds `first_name`,
  `last_name`, `state` ("Collected at checkout", written by the Paddle webhook
  under service-role, read-own RLS, no user-insert by design). Extend that table
  rather than building a new user-insert form — it keeps the trusted write path
  and avoids reversing the no-user-insert RLS. The owner runs any DDL in the
  Supabase dashboard (Claude is blocked from DDL).
- Show the **disclaimer** at that step, both languages, reviewed before shipping:
  stored securely, used only to check whether a case of theirs comes up, never
  for marketing, never sold, includes storing which breaches their email is in,
  deletable on request.
- Store the subscriber's **matched breach list** so the alert job does not
  re-query HIBP per user per run (HIBP is rate-limited); covered by the same
  disclaimer and RLS.
- A **monitoring match + alert** cron compares each subscriber's matched
  settlements against newly opened cases and emails them (Brevo) once per case,
  linking to the official site.
- Still US-only, via Paddle, so **blocked on Paddle going live** (domain
  approval). The free money card and the dataset work do not depend on Paddle.

## What is left to the builder

- The scraper's exact strategy for comprehensiveness, dedup, and preserving
  closed-settlement history across runs.
- How `origen` is decided in practice (scraper classification, radar cross-ref,
  or both) and where the ransomware signal is most reliable.
- The monitoring match logic and the alert trigger (cron cadence, what counts as
  "newly opened for this user", dedup so one case alerts once).
- The exact PII columns and the Supabase RLS, written for the owner to run as DDL.
- The monitoring signup UI and the exact disclaimer wording, both languages,
  reviewed before shipping.
- How the "pérdidas" total is computed and framed without overpromising.
- Sequencing against the Paddle dependency: ship the dataset + free money card
  first (no Paddle needed); land the paid monitoring when Paddle is live.

## Calls settled after the builder review (2026-10-31)

Owner decisions:
- Monitoring PII: **first name, last name, US state, email only** — no street
  address.
- **Store the subscriber's matched breaches** (for the monitoring match),
  under the same disclaimer.
- See the monitoring signup mockup (artifact `6BgxiDoNTSpkDL9RbDdAWf`).

My calls (a sensible builder could settle these; flagged here to check):
- **Pipeline repair** is in scope and is the foundation: the scraper's fresh
  output must reach the `hibp`-matched `settlements.json`, since that path is
  currently broken/frozen.
- PII is captured at the **Paddle monitoring checkout**, extending
  `alert_subscriptions` + its webhook — not a new on-site user-insert form.
- `origen` defaults to `brecha`; the Daily Hack radar cross-ref is weak because
  radar victim domains are masked (e.g. `sp***g.com`), so most rows will be
  `brecha` unless the scraper itself flags ransomware.
- The **"pérdidas" total must not be summed as guaranteed money lost**:
  `porPersona` is a *maximum* (e.g. "$25,000"), so the copy frames it as "up to"
  and avoids implying the person was owed that sum. Over-promising is an anti-goal.
- The hardcoded UI counts in `app.js` ("1,614 cases tracked, 307 still open")
  are stale vs `settlements.json` and should be driven from the data.

## Suggested build order

1. Dataset: `origen` field + comprehensiveness + closed-history + cron. (Foundation.)
2. Free money card: origin labels + "pérdidas" total. (Depends on 1.)
3. Paid monitoring: PII capture + disclaimer + match + alert. (Depends on 1; the
   go-live depends on Paddle.)
