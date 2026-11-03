# Breach Alerts Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-shot HIBP check into a recurring per-subscriber breach-alert flow: capture emails, check each daily against HIBP, and email only the breaches that are new since last check.

**Architecture:** A pure ESM core (`api/_breach-watch.mjs`) holds all logic (validate, diff, decide, orchestrate, mail copy, auth) and is unit-tested with Node's built-in runner. Thin Vercel handlers (`api/monitor-signup.js`, `api/run-breach-alerts.js`) wire real I/O (HIBP fetch, Supabase service-role helpers already in `_shared.js`, Brevo send in `_email.js`) into that core. The daily trigger is the existing "Radar de Ataques diario" cloud routine POSTing to the gated endpoint, not a new Vercel cron.

**Tech Stack:** Vanilla ESM on Vercel serverless (no npm deps), Node 24 built-in `node:test`, Supabase/PostgREST, HIBP API v3, Brevo HTTP API.

**Spec:** `docs/superpowers/specs/2026-11-02-breach-alerts-design.md`

## Global Constraints

- No npm dependencies. Tests use only `node:test` + `node:assert/strict`. `_email.js` comment is explicit: this project carries no dependencies.
- Testable logic lives in `.mjs` modules so `node --test <file>.test.mjs` runs locally (the `api/*.js` handlers only run as ESM under Vercel's bundler, not plain local Node). Handlers stay thin and are verified on a preview deploy or via an authenticated dry-run.
- Never log an email address. Logs carry `error.name` only, matching `check-email.js`.
- Fail closed: `run-breach-alerts` requires `CRON_SECRET` (503 if unset, 401 on mismatch, constant-time compare).
- Idempotent: a subscriber's row is marked (known_breaches / baseline_done updated) only after a successful send, so a double-fire sends no duplicates and a failed send retries next day.
- Copy is neutral Spanish (tú-form, no voseo) and English, both provided. No emojis, no em-dashes.
- Mail path reuses `layout()` and the `send()` contract in `_email.js` (returns false, never throws).
- US-only gating does NOT apply here: breach-capture is open to ES and EN visitors. (Paddle billing, which is US-only, is out of scope.)

## Review Focus

- HIBP 429/timeout for one subscriber mid-run: must skip that subscriber (no mail, no row update, counted as error) without halting the job. Covered in Task 2.
- Radar double-fire / job run twice same day: no duplicate alerts. Covered in Task 2 (idempotency test).
- Brevo send failure: must NOT add the breach to known_breaches, or the subscriber never gets that alert. Covered in Task 2 (patch-after-send test).
- Email casing/whitespace producing duplicate subscriber rows. Covered in Task 1 (normalizeEmail) + Task 3 (planSignup noop/reactivate) + the DDL unique index.
- Unauthenticated or forged call to `run-breach-alerts` spending HIBP quota and sending mail. Covered in Task 2 (authorizeCron/secretMatches) + Task 5 (gate wiring).

---

## Prerequisites (owner-gated, not TDD tasks)

- **DDL (owner runs in Supabase dashboard, project `am-i-exposed`, id `morosdhhoznicppmrqyr`; Claude is blocked from DDL):**

```sql
create table if not exists breach_watch (
  id                 bigint generated always as identity primary key,
  email              text not null,
  status             text not null default 'active',
  plan               text not null default 'free_capture',
  lang               text,
  known_breaches     text[] not null default '{}',
  baseline_done      boolean not null default false,
  last_checked_at    timestamptz,
  created_at         timestamptz not null default now(),
  unsubscribe_token  uuid not null default gen_random_uuid()
);
create unique index if not exists breach_watch_email_key on breach_watch (email);
```

Emails are normalized (lowercased/trimmed) in app code before insert, so the plain `email` unique index is sufficient.

- **`CRON_SECRET`:** already set on the project (it gates `keepalive` and `healthcheck`). No new env var is needed for the MVP.
- **Radar trigger (ops, after Task 5 deploys):** the daily routine adds one authenticated call `POST https://www.am-i-exposed.com/api/run-breach-alerts` with header `Authorization: Bearer <CRON_SECRET>`. The routine must hold the secret. No `vercel.json` cron change (Hobby's 2 slots stay as-is).

---

## File Structure

- Create `api/_breach-watch.mjs` — pure core: `normalizeEmail`, `isValidEmail`, `newBreaches`, `mergeKnown`, `decideAction`, `secretMatches`, `authorizeCron`, `processSubscribers`, `planSignup`, `breachWelcomeCopy`, `breachAlertCopy`. No I/O.
- Create `api/_breach-watch.test.mjs` — `node:test` suite for the above.
- Modify `api/_email.js` — add `sendBreachWelcome`, `sendBreachAlert` (import copy builders from `_breach-watch.mjs`).
- Create `api/monitor-signup.js` — `POST` capture endpoint (thin).
- Create `api/run-breach-alerts.js` — gated daily endpoint (thin), with `?dryrun=1`.
- Modify `index.html`, `es/index.html`, `app.js`, `app.css` — minimal capture form (bump `?v=`).

---

### Task 1: Pure core — validate, diff, decide

**Files:**
- Create: `api/_breach-watch.mjs`
- Test: `api/_breach-watch.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeEmail(email: string) -> string` (lowercased, trimmed)
  - `isValidEmail(email: string) -> boolean` (same rule as `check-email.js`: `length<=254`, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`)
  - `newBreaches(returned: string[], known: string[]) -> string[]` (names in `returned` not in `known`, first-seen order, de-duplicated)
  - `mergeKnown(known: string[], returned: string[]) -> string[]` (sorted union, unique)
  - `decideAction({ baselineDone: boolean, newNames: string[], returnedNames: string[] }) -> { kind: 'welcome'|'alert'|'none', breaches?: string[] }`

- [ ] **Step 1: Write the failing tests** in `api/_breach-watch.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, isValidEmail, newBreaches, mergeKnown, decideAction } from './_breach-watch.mjs';

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  A@B.COM '), 'a@b.com');
});
test('isValidEmail accepts and rejects', () => {
  assert.equal(isValidEmail('a@b.com'), true);
  assert.equal(isValidEmail('nope'), false);
  assert.equal(isValidEmail('a@b'), false);
});
test('newBreaches returns only names not already known, unique, in order', () => {
  assert.deepEqual(newBreaches(['B', 'A', 'B'], ['A']), ['B']);
  assert.deepEqual(newBreaches(['A'], ['A', 'B']), []);
  assert.deepEqual(newBreaches(['C', 'D', 'C'], []), ['C', 'D']);
});
test('mergeKnown is a sorted unique union', () => {
  assert.deepEqual(mergeKnown(['A'], ['C', 'A', 'B']), ['A', 'B', 'C']);
});
test('decideAction: first check is a welcome with the full current exposure', () => {
  assert.deepEqual(decideAction({ baselineDone: false, newNames: ['A'], returnedNames: ['A'] }), { kind: 'welcome', breaches: ['A'] });
  assert.deepEqual(decideAction({ baselineDone: false, newNames: [], returnedNames: [] }), { kind: 'welcome', breaches: [] });
});
test('decideAction: later check alerts only on new names', () => {
  assert.deepEqual(decideAction({ baselineDone: true, newNames: ['C'], returnedNames: ['A', 'C'] }), { kind: 'alert', breaches: ['C'] });
  assert.deepEqual(decideAction({ baselineDone: true, newNames: [], returnedNames: ['A'] }), { kind: 'none' });
});
```

- [ ] **Step 2: Run the tests, verify they fail** — `node --test api/_breach-watch.test.mjs` — Expected: FAIL (module/exports missing).
- [ ] **Step 3: Implement the five functions** in `api/_breach-watch.mjs`. Pure, no imports except `node:` built-ins if needed.
- [ ] **Step 4: Run the tests, verify they pass** — `node --test api/_breach-watch.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: breach-watch pure core (validate, diff, decide)`.

---

### Task 2: Orchestrator and auth

**Files:**
- Modify: `api/_breach-watch.mjs`
- Test: `api/_breach-watch.test.mjs`

**Interfaces:**
- Consumes: `newBreaches`, `mergeKnown`, `decideAction` from Task 1.
- Produces:
  - `secretMatches(given: string, expected: string) -> boolean` (constant-time, same shape as `healthcheck.js`)
  - `authorizeCron(authHeader: string, secret: string) -> boolean` (true only for `Bearer <secret>`)
  - `processSubscribers({ subscribers, hibpLookup, sendWelcome, sendAlert, patch, now }) -> { checked, welcomed, alerted, errors }` where:
    - `subscribers`: rows `{ id, email, known_breaches, baseline_done }`
    - `hibpLookup(email) -> { status: 'clean'|'found'|'error', names: string[] }`
    - `sendWelcome(sub, breaches) -> Promise<boolean>`, `sendAlert(sub, newNames) -> Promise<boolean>`
    - `patch(id, fields) -> Promise<boolean>`, `now() -> string`
    - Behavior: on `error` status, skip (no mail, no patch), `errors++`. On welcome/alert, send first; only if send returns true, `patch(id, { known_breaches: mergeKnown(...), baseline_done: true, last_checked_at: now() })` and increment welcomed/alerted; if send is false, `errors++` and do not patch. On `none`, `patch(id, { last_checked_at: now() })` only.

- [ ] **Step 1: Write the failing tests** (append to `api/_breach-watch.test.mjs`)

```js
import { secretMatches, authorizeCron, processSubscribers } from './_breach-watch.mjs';

test('secretMatches is true only on exact match', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abc', 'abd'), false);
  assert.equal(secretMatches('', 'abc'), false);
  assert.equal(secretMatches('ab', 'abc'), false);
});
test('authorizeCron accepts only Bearer <secret>', () => {
  assert.equal(authorizeCron('Bearer s3cret', 's3cret'), true);
  assert.equal(authorizeCron('s3cret', 's3cret'), false);
  assert.equal(authorizeCron('Bearer wrong', 's3cret'), false);
});

function fakes(lookups) {
  const sent = [];
  const patched = [];
  return {
    hibpLookup: async (email) => lookups[email],
    sendWelcome: async (sub, breaches) => { sent.push(['welcome', sub.id, breaches]); return true; },
    sendAlert: async (sub, names) => { sent.push(['alert', sub.id, names]); return true; },
    patch: async (id, fields) => { patched.push([id, fields]); return true; },
    now: () => '2026-11-02T00:00:00Z',
    sent, patched,
  };
}

test('first check sends welcome and sets baseline', async () => {
  const f = fakes({ 'a@b.com': { status: 'clean', names: [] } });
  const counts = await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: [], baseline_done: false }], ...f });
  assert.deepEqual(counts, { checked: 1, welcomed: 1, alerted: 0, errors: 0 });
  assert.equal(f.patched[0][1].baseline_done, true);
});
test('later check alerts only on new breach and unions known', async () => {
  const f = fakes({ 'a@b.com': { status: 'found', names: ['A', 'C'] } });
  await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: ['A'], baseline_done: true }], ...f });
  assert.deepEqual(f.sent[0], ['alert', 1, ['C']]);
  assert.deepEqual(f.patched[0][1].known_breaches, ['A', 'C']);
});
test('no new breach sends nothing, patches only last_checked_at', async () => {
  const f = fakes({ 'a@b.com': { status: 'found', names: ['A'] } });
  const counts = await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: ['A'], baseline_done: true }], ...f });
  assert.equal(f.sent.length, 0);
  assert.deepEqual(Object.keys(f.patched[0][1]), ['last_checked_at']);
  assert.equal(counts.alerted, 0);
});
test('hibp error skips subscriber: no mail, no patch, counted', async () => {
  const f = fakes({ 'a@b.com': { status: 'error', names: [] } });
  const counts = await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: [], baseline_done: true }], ...f });
  assert.equal(f.sent.length, 0);
  assert.equal(f.patched.length, 0);
  assert.equal(counts.errors, 1);
});
test('send failure does not mark breach known (retries next day)', async () => {
  const f = fakes({ 'a@b.com': { status: 'found', names: ['C'] } });
  f.sendAlert = async () => false;
  const counts = await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: [], baseline_done: true }], ...f });
  assert.equal(f.patched.length, 0);
  assert.equal(counts.errors, 1);
});
```

- [ ] **Step 2: Run, verify fail** — `node --test api/_breach-watch.test.mjs` — Expected: FAIL (new exports missing).
- [ ] **Step 3: Implement** `secretMatches`, `authorizeCron`, `processSubscribers` in `api/_breach-watch.mjs`.
- [ ] **Step 4: Run, verify pass** — `node --test api/_breach-watch.test.mjs` — Expected: PASS (all Task 1 + Task 2 tests).
- [ ] **Step 5: Commit** — `feat: breach-watch orchestrator and cron auth`.

---

### Task 3: Signup planning + `/api/monitor-signup`

**Files:**
- Modify: `api/_breach-watch.mjs`
- Create: `api/monitor-signup.js`
- Test: `api/_breach-watch.test.mjs`

**Interfaces:**
- Consumes: `normalizeEmail`, `isValidEmail` (Task 1); from `_shared.js`: `rateLimitOk`, `sbSelect`, `sbInsert`, `sbPatch`, `readBody`, `isAllowedOrigin`.
- Produces: `planSignup(existingRow, { email, lang }) -> { action: 'insert', row } | { action: 'reactivate', patch } | { action: 'noop' }`.

- [ ] **Step 1: Write the failing tests** (append to `api/_breach-watch.test.mjs`)

```js
import { planSignup } from './_breach-watch.mjs';

test('planSignup inserts a new active free_capture row', () => {
  const p = planSignup(null, { email: 'a@b.com', lang: 'es' });
  assert.equal(p.action, 'insert');
  assert.equal(p.row.status, 'active');
  assert.equal(p.row.plan, 'free_capture');
  assert.equal(p.row.email, 'a@b.com');
});
test('planSignup reactivates an unsubscribed row', () => {
  const p = planSignup({ id: 5, status: 'unsubscribed' }, { email: 'a@b.com', lang: 'en' });
  assert.equal(p.action, 'reactivate');
  assert.equal(p.patch.status, 'active');
});
test('planSignup is a noop for an already-active row', () => {
  assert.deepEqual(planSignup({ id: 5, status: 'active' }, { email: 'a@b.com', lang: 'es' }), { action: 'noop' });
});
```

- [ ] **Step 2: Run, verify fail** — `node --test api/_breach-watch.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement `planSignup`** in `_breach-watch.mjs`, then implement the handler `api/monitor-signup.js`:
  - `POST` only; `OPTIONS` 204; same origin guard as `check-email.js` (`isAllowedOrigin`).
  - `readBody`; require a truthy consent flag in the body (e.g. `body.consent === true`); 400 if missing.
  - `email = normalizeEmail(body.email)`; 400 if `!isValidEmail`.
  - `rateLimitOk(clientIp, 5, 60)` guard (same fallback shape as `check-email.js`); 429 if over.
  - `sbSelect(\`breach_watch?email=eq.${encodeURIComponent(email)}&select=id,status\`)` → `planSignup`.
  - `insert` → `sbInsert('breach_watch', row)`; `reactivate` → `sbPatch(\`breach_watch?id=eq.${id}\`, patch)`; `noop` → nothing.
  - Always answer 200 `{ ok: true }` for insert/reactivate/noop (do not reveal whether the email already existed). `Cache-Control: private, no-store`. Never log the email.
- [ ] **Step 4: Run, verify pass** — `node --test api/_breach-watch.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: monitor-signup endpoint and signup planning`.

---

### Task 4: Mail copy + `_email.js` senders

**Files:**
- Modify: `api/_breach-watch.mjs`
- Modify: `api/_email.js`
- Test: `api/_breach-watch.test.mjs`

**Interfaces:**
- Produces (pure, in `_breach-watch.mjs`):
  - `breachWelcomeCopy(lang, breaches: string[]) -> { subject: string, lines: string[] }`
  - `breachAlertCopy(lang, newBreaches: string[]) -> { subject: string, lines: string[] }`
- Produces (I/O, in `_email.js`): `sendBreachWelcome({ to, lang, breaches, siteUrl, unsubscribeUrl }) -> Promise<boolean>`, `sendBreachAlert({ to, lang, newBreaches, siteUrl, unsubscribeUrl }) -> Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** (append to `api/_breach-watch.test.mjs`)

```js
import { breachWelcomeCopy, breachAlertCopy } from './_breach-watch.mjs';

test('welcome copy differs by lang and lists exposure', () => {
  const es = breachWelcomeCopy('es', ['LinkedIn']);
  const en = breachWelcomeCopy('en', ['LinkedIn']);
  assert.ok(es.subject.length > 0 && en.subject.length > 0);
  assert.notEqual(es.subject, en.subject);
  assert.ok(es.lines.join(' ').includes('LinkedIn'));
});
test('welcome copy handles a clean result', () => {
  const es = breachWelcomeCopy('es', []);
  assert.ok(es.lines.length > 0);
});
test('alert copy names the new breaches', () => {
  const es = breachAlertCopy('es', ['Dropbox']);
  assert.ok(es.lines.join(' ').includes('Dropbox'));
});
```

- [ ] **Step 2: Run, verify fail** — `node --test api/_breach-watch.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** the two copy builders in `_breach-watch.mjs` (neutral Spanish + English; welcome is not an alarm, alert is). Then in `_email.js`, `import { breachWelcomeCopy, breachAlertCopy } from './_breach-watch.mjs';` and add `sendBreachWelcome` / `sendBreachAlert` that call the existing `layout()` (add an unsubscribe line to the footer via `unsubscribeUrl`) and the existing internal `send()`. Return false on misconfig, like the rest of the module.
- [ ] **Step 4: Run, verify pass** — `node --test api/_breach-watch.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: breach welcome and alert mail`.

---

### Task 5: `/api/run-breach-alerts` (gated, dry-run)

**Files:**
- Create: `api/run-breach-alerts.js`

**Interfaces:**
- Consumes: `authorizeCron`, `processSubscribers` (Task 2); `sbSelect`, `sbPatch` (`_shared.js`); `sendBreachWelcome`, `sendBreachAlert` (`_email.js`); `publicBaseUrl` (`_shared.js`).
- Produces: the daily endpoint. No new exports.

This task is I/O wiring; its logic is already unit-tested in Task 2. Verify it on a preview deploy with an authenticated dry-run, not with a local unit test.

- [ ] **Step 1: Implement** `api/run-breach-alerts.js`:
  - Gate: `const secret = process.env.CRON_SECRET;` 503 if unset; `if (!authorizeCron(req.headers.authorization || '', secret)) return 401`.
  - `const dry = req.query?.dryrun === '1' || (req.url||'').includes('dryrun=1');`
  - Load: `sbSelect('breach_watch?status=eq.active&select=id,email,known_breaches,baseline_done')`.
  - `hibpLookup(email)`: GET `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false` with headers `{ 'User-Agent': 'Am-I-Exposed-Watch', 'hibp-api-key': process.env.HIBP_API_KEY }`, 8s timeout. 404 → `{status:'clean',names:[]}`; 200 → `{status:'found', names: body.map(b=>b.Name)}`; else → `{status:'error',names:[]}`. Pace sequentially (await a short delay between calls) to stay under the HIBP plan's shared limit.
  - Wire real `sendWelcome`/`sendAlert` (build `unsubscribeUrl` from `publicBaseUrl(req)` + token — include `unsubscribe_token` in the select if the unsubscribe route is built; otherwise pass a site link for now) and real `patch` = `(id, fields) => sbPatch(\`breach_watch?id=eq.${id}\`, fields).then(r=>r.ok)`.
  - Dry-run swaps `sendWelcome`/`sendAlert`/`patch` for no-ops that only count, so the pipe can be exercised on real data without sending or writing.
  - `const counts = await processSubscribers({ subscribers, hibpLookup, sendWelcome, sendAlert, patch, now: ()=>new Date().toISOString() });`
  - Respond `200 { ok:true, dry, ...counts, at }`. Never include emails. `Cache-Control: private, no-store`.
- [ ] **Step 2: Deploy to a preview and dry-run** — authenticated: `curl -s -X POST "$PREVIEW/api/run-breach-alerts?dryrun=1" -H "Authorization: Bearer $CRON_SECRET"` — Expected: `200 {"ok":true,"dry":true,...}`; an unauthenticated call returns 401. (Seed one `active` row first, or confirm `checked:0` on an empty table.)
- [ ] **Step 3: Commit** — `feat: run-breach-alerts daily endpoint with dry-run`.

---

### Task 6: Minimal capture form (EN + ES)

**Files:**
- Modify: `index.html`, `es/index.html`, `app.js`, `app.css`

A small capture block ("we monitor your email and alert you") that POSTs to `/api/monitor-signup`. This is the minimum to feed the table; the dedicated pricing page (separate work) will restyle and relocate it. CSP needs no change (`connect-src 'self'`, `form-action 'self'` already cover it).

- [ ] **Step 1: Add the form** to both `index.html` and `es/index.html` (same structure, translated copy): an email input, a required consent checkbox with the "we store your email to alert you; unsubscribe anytime" line, and a submit button. Use existing brand tokens/classes.
- [ ] **Step 2: Add the submit handler** in `app.js`: on submit, POST `{ email, lang, consent: true }` to `/api/monitor-signup`, show a success state on `ok:true`, a gentle error otherwise. Bump the `?v=` cache-bust on `app.js` (and `app.css` if touched) in both HTML files.
- [ ] **Step 3: Verify on a preview** — open the preview, submit a test email, confirm the `/api/monitor-signup` request returns 200 (read_network_requests), confirm the success state renders (read_page), and confirm a row landed via `sbSelect` or the dry-run `checked` count. Check both `/` and `/es/`.
- [ ] **Step 4: Commit** — `feat: minimal breach-monitor capture form (EN+ES)`.

---

## Self-Review notes

- Spec coverage: capture (Task 3 + 6), daily per-subscriber check (Task 5 + 2), diff/dedup (Task 1), welcome vs alert (Task 1 + 4), send (Task 4), gate (Task 2 + 5), privacy consent + no-email-logs (Task 3/5 + Global Constraints), DDL + Radar trigger (Prerequisites). Settlements/combo and Paddle billing are explicit non-goals of this plan.
- Type consistency: `hibpLookup` returns `{status,names}` everywhere; `patch(id, fields)` signature is identical in Task 2 tests and Task 5 wiring; copy builders return `{subject,lines}` consumed by `_email.js` senders.
- The two handlers (Tasks 5, 6) carry the only deploy-verified surface; all branching logic is pushed into the `.mjs` core and unit-tested, keeping the untested glue minimal and honest given the project has no local handler test harness.
