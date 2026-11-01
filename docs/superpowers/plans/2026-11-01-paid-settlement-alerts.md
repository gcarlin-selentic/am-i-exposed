# Paid settlement alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email $3/mo subscribers a welcome digest of the settlements open now and alert them when a new one opens, built ready to flip on when Paddle is live.

**Architecture:** A daily Vercel cron (`api/settlement-alerts.js`) reads
`data/open-settlements.json` from the deployed bundle and the active subscriber
list from Supabase (service-role, same boundary that already holds the PII),
decides per subscriber what to send (a welcome digest on first contact, then only
newly-opened cases, deduped against a Supabase table), and sends via Brevo. Pure
selection logic lives in a testable module; the cron is thin wiring. The public
`/settlements/` SEO pages and the free money card are untouched.

**Tech Stack:** Node.js (Vercel serverless, ESM), standard library + existing
helpers (`api/_shared.js` Supabase REST, `api/_email.js` Brevo). Tests use
`node:test` (built in, no new dependency), run with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-01-paid-settlement-alerts-design.md`

## Global Constraints

- Monitoring, **not a promise of money**. Copy says "you may be able to claim",
  never "you are owed"; amounts are shown "up to $X" (the published max/range),
  never summed or guaranteed. (Spec: Intent, Anti-goals.)
- Notify + link to the **official administrator** only; never file, never a copycat.
- US-only, via Paddle; Paddle is not live, so the path is built and testable with
  a seeded test subscription, flipped on later. (Spec: Constraints.)
- Alert endpoint is **fail-closed** behind `CRON_SECRET` (same pattern as
  `api/healthcheck.js`): no secret or wrong token → it does not run.
- Exclude non-data-breach rows from alerts (the `filtracion` flag, and drop known
  mis-flags like Hyundai/Kia car-theft). (Spec.)
- Subscriber PII (name, state, email, breach names) never leaves Vercel/Supabase
  and is used only for the alert. (Spec.)
- Both languages for any visitor-facing copy; bump `app.js` `?v=` on JS changes.
- Stdlib + existing helpers only; no new runtime dependency.

## Review Focus

- **A settlement whose claim window has already closed is alerted** — must be
  dropped (`plazo` < today); Task 2 test.
- **The same settlement alerts the same subscriber twice** (two cron runs) — dedup
  must hold; Task 2 test on the already-alerted set.
- **A non-data-breach row (`filtracion:false`, or a Hyundai/Kia-type mis-flag)
  reaches the alert** — must be excluded; Task 2 test.
- **A brand-new subscriber gets silence** when cases are open — the welcome digest
  must include all currently-open cases on first contact; Task 2 test.
- **The alert endpoint runs for an unauthenticated caller** and spends Brevo/reads
  PII — must be fail-closed on `CRON_SECRET`; Task 3 test.

---

## File Structure

- `api/_settlement-alerts.js` — created. Pure selection/format logic (no I/O),
  testable.
- `api/settlement-alerts.js` — created. The Vercel cron endpoint: auth, read
  data + subscribers, call the pure logic, send Brevo, record dedup.
- `api/_email.js` — modified. Add `sendSettlementAlert({to, lang, html, subject})`
  (reuses the private `send`).
- `vercel.json` — modified. Add the daily cron for `/api/settlement-alerts`.
- `tools/tests/` is Python; JS tests live in `api/__tests__/alerts.test.mjs`
  (created), run with `node --test api/__tests__/`.
- `supabase_settlement_alerts_sent.sql` — created. DDL for the dedup table (owner
  runs it in the Supabase dashboard).

### Task 1: Signup disclaimer copy (both languages)

**Files:**
- Modify: `app.js` (the `COPY` object, `es` and `en` blocks — add the disclaimer
  strings), and wherever the alerts offer card renders its body.
- Modify: `index.html` and `es/index.html` if the disclaimer is static markup.

**Interfaces:**
- Produces: `COPY.es.alertsDisclaimer` / `COPY.en.alertsDisclaimer` strings, shown
  at the monitoring offer / checkout step.

- [ ] **Step 1: Add the disclaimer copy** (both languages) matching the approved
  mockup (artifact `6BgxiDoNTSpkDL9RbDdAWf`): stored securely, used only to check
  whether a case of theirs comes up, never for marketing, never sold, includes
  storing which breaches their email is in, deletable on request. English under
  `COPY.en.alertsDisclaimer`, Spanish under `COPY.es.alertsDisclaimer`.
- [ ] **Step 2: Render it** in the alerts offer card (near the subscribe button),
  reading from `t().alertsDisclaimer`. Bump `app.js` `?v=` in both index files.
- [ ] **Step 3: Verify** in the browser preview (both `/` and `/es/`): the
  disclaimer shows under the alerts card. Screenshot.
- [ ] **Step 4: Commit** (`git add app.js index.html es/index.html`).

### Task 2: Pure alert-selection logic

**Files:**
- Create: `api/_settlement-alerts.js`
- Test: `api/__tests__/alerts.test.mjs`

**Interfaces:**
- Produces:
  - `isClaimableBreach(row, todayISO) -> bool` — true when `row.filtracion` is
    true, `row.plazo` exists and is `>= todayISO`, and the row is not in the
    hardcoded non-breach denylist (e.g. a Hyundai/Kia slug/name).
  - `settlementId(row) -> string` — a stable id for dedup (the claim site host, or
    a slug of `empresa` + `plazo`).
  - `toAlertItem(row) -> {company, amount, deadlineISO, site, cubre}` — amount is
    `row.pago_texto` verbatim (already "up to $X"/range), never computed.
  - `selectForSubscriber(openRows, alreadySentIds, todayISO) -> {welcome:bool, items:[]}`
    — all currently-claimable items whose id is not in `alreadySentIds`; `welcome`
    is true when `alreadySentIds` is empty (first contact).

- [ ] **Step 1: Write the tests** in `api/__tests__/alerts.test.mjs` using
  `node:test` + `node:assert`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClaimableBreach, selectForSubscriber, settlementId } from '../_settlement-alerts.js';

const OPEN = {empresa:'Baptist Health', pago_texto:'$4,480', plazo:'2026-12-08',
              sitio_reclamo:'bhsettlement.com', filtracion:true, cubre:'...'};

test('closed window is not claimable', () => {
  assert.equal(isClaimableBreach({...OPEN, plazo:'2020-01-01'}, '2026-11-01'), false);
});
test('non-breach row is not claimable', () => {
  assert.equal(isClaimableBreach({...OPEN, filtracion:false}, '2026-11-01'), false);
});
test('hyundai/kia car-theft is excluded', () => {
  assert.equal(isClaimableBreach({...OPEN, empresa:'Hyundai, Kia'}, '2026-11-01'), false);
});
test('new subscriber gets a welcome with all open items', () => {
  const r = selectForSubscriber([OPEN], [], '2026-11-01');
  assert.equal(r.welcome, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].amount, '$4,480');
});
test('already-alerted settlement is not re-sent', () => {
  const r = selectForSubscriber([OPEN], [settlementId(OPEN)], '2026-11-01');
  assert.equal(r.items.length, 0);
});
```

- [ ] **Step 2: Run, expect FAIL** — Run: `node --test api/__tests__/` — module not found / functions undefined.
- [ ] **Step 3: Implement** `api/_settlement-alerts.js` with the four functions in
  the Interfaces block. The non-breach denylist is a small `Set` of normalized
  names/slugs; `settlementId` uses the claim-site host when present else a slug.
- [ ] **Step 4: Run, expect PASS** — Run: `node --test api/__tests__/`.
- [ ] **Step 5: Commit.**

### Task 3: The alert cron endpoint

**Files:**
- Create: `api/settlement-alerts.js`
- Modify: `api/_email.js` (add `sendSettlementAlert`), `vercel.json` (cron)
- Create: `supabase_settlement_alerts_sent.sql` (owner runs)
- Test: `api/__tests__/alerts.test.mjs` (auth-gate test on the handler helper)

**Interfaces:**
- Consumes: `selectForSubscriber`, `toAlertItem`, `settlementId` (Task 2);
  `sbSelect`/`sbInsert` from `api/_shared.js`; `sendSettlementAlert` (this task).
- Produces: a default handler that, when authorized, for each active subscription
  reads its already-sent ids, selects, emails, and records the new ids.

- [ ] **Step 1: Write the auth test** — the handler returns 503 when `CRON_SECRET`
  is unset and 401 on a wrong bearer, running no selection (extract the guard into
  a `requireCron(req) -> {ok, status}` helper and test it like `api/healthcheck.js`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `api/settlement-alerts.js`: fail-closed `CRON_SECRET`
  guard; read `data/open-settlements.json` via `fs` (bundled at the function path);
  read active subscriptions (`alert_subscriptions`, status in active/trialing/
  past_due, live_mode matching) and their already-sent ids (new table); for each,
  `selectForSubscriber`, build the email (welcome vs new; "up to" amounts; official
  links; the monitoring disclaimer line, not a promise), `sendSettlementAlert`, and
  on success `sbInsert` the new ids. Add `sendSettlementAlert` to `_email.js`.
- [ ] **Step 4: Add the cron** to `vercel.json` `crons`: `{ "path":
  "/api/settlement-alerts", "schedule": "0 14 * * *" }` (daily, 09:00 Lima), and
  write `supabase_settlement_alerts_sent.sql` (table: `user_id`, `settlement_id`,
  `sent_at`, unique on `(user_id, settlement_id, live_mode)`, read-own RLS).
- [ ] **Step 5: Run the suite** (`node --test api/__tests__/`), then a local dry
  run of the handler with a seeded fake subscriber + `CRON_SECRET` set, asserting
  it selects and would send (stub the Brevo send) — read the output.
- [ ] **Step 6: Commit.** Note in the message that the owner must run
  `supabase_settlement_alerts_sent.sql` and set `CRON_SECRET` is already present.

### Task 4: Capture the subscriber's breaches at checkout

**Files:**
- Modify: `api/_paddle.js` (read breach names from `custom_data`),
  `api/` Paddle webhook handler (persist them with the subscription).
- Modify: `supabase_alert_subscriptions.sql` (add a `breaches text[]` column; owner
  runs the `alter table`).
- Modify: `api/_settlement-alerts.js` + its tests (flag per-breach matches).

**Interfaces:**
- Produces: subscriptions carry `breaches` (string[]); `selectForSubscriber` gains
  an optional `breaches` arg and marks `item.matchesYou = true` when a settlement's
  company matches one of them (same whole-token rule as the pipeline, reused or
  reimplemented minimally).

- [ ] **Step 1: Write the test** — `selectForSubscriber(open, [], today, ['Baptist
  Health'])` marks the Baptist Health item `matchesYou:true`; a non-matching
  breach list leaves it false.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the `breaches` flow: webhook reads `custom_data`
  breach names (already known from the buyer's free check), stores them on the
  subscription; `selectForSubscriber` flags matches; the email surfaces a matched
  item first with a "this one matches a breach you're in" line.
- [ ] **Step 4: Run the suite, expect PASS.**
- [ ] **Step 5: Commit** (note the `alter table ... add column breaches` for the owner).

---

## Notes for the executor

- Do not touch the public `/settlements/` pages, the free money card, or the
  scraper — all out of scope.
- The paid path cannot be charged until Paddle is live; everything here is built
  and tested with a seeded test subscription and flipped on later.
- Per-state prioritization is dropped (open rows carry no structured state).
- The alert's new-case timeliness is bound by the weekly scraper; that is a known
  limit, not a bug to fix here.
