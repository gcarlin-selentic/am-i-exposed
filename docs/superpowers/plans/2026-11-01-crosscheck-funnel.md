# Cross-check funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the free email check on the home, let the visitor tick the companies they have dealt with (Paso 2) and their state, show a single free hook number ("you could claim up to $X across N settlements where you might qualify"), and lock the itemized list behind $5 one-time (see the list) and $3/mo · $30/yr (monitoring), both through the existing Paddle rail.

**Architecture:** A pure, tested matching function turns {email breaches, picked companies, state, settlement dataset, today} into {items, totalMax, openCount}. A single reconciled dataset (`funnel.json`) carries the open settlements with numeric per-person amounts and company names, alongside the existing HIBP-matched set in `settlements.json`. The home renders Paso 2 + the number + a locked list; the gate reuses the current Paddle subscription checkout (adding the $30/yr price) and adds a $5 one-time Paddle checkout that reveals the list. All visitor-facing counts read from one source of truth.

**Tech Stack:** Static site (vanilla HTML/CSS/JS), Python build scripts, Vercel serverless (Node ESM) for checkout, Paddle Billing (one-time + subscription), node:test + pytest.

**Spec:** The approved cross-check preview `scratchpad/crosscheck-funnel.html` and the confirmed answers in this conversation (free = only the number; Paso 2 = company picker + state; $5 one-time = the list; $3/mo · $30/yr = monitoring; monitoring is "we watch and tell you", never a promise of payment; link to the official administrator only, never file).

## Global Constraints

- English on the EN home (`index.html`), Spanish on the ES home (`es/index.html`); logic and i18n strings live in `app.js` and must be added in both languages.
- US-only monetization. The paid gate runs through Paddle; while Paddle has not approved the domain, `/api/alerts-config` reports `eligible:false` and `/api/checkout` returns no price. The funnel's free part (Paso 2, the number, the locked list) must render and work regardless; the paid buttons light up only when the rail is live. No dead button that appears to charge and cannot.
- Monitoring is surveillance, not a promise: copy says "we watch and tell you if something opens where you could qualify", never "you will receive money". Keep the existing caveat: appearing in a breach is not class membership; we are not lawyers; we never file.
- The claim/administrator link always points at the court-appointed administrator, validated by the existing `sitioValido()` / `sitioExterno()` guards. Never link to a search or an affiliate.
- "Up to $X" means the sum of published maximum per-person amounts, labelled "up to" and "not a promise of payment". Never present it as owed or guaranteed.
- One source of truth for every visitor-facing count. After this plan, the home, the alerts card and the funnel all read the same numbers; no hardcoded `1,614`, and the `2,182` meta is reconciled to the publishable universe or removed from visitor copy.
- Amounts are rendered with the existing `Intl.NumberFormat` currency helper and locale, not hand-formatted.

## Review Focus

- Visitor picks no companies and their email matched nothing: the number must read $0 / "nothing open we can see", not a broken or blank card, and must not invite payment for an empty list.
- A scraped open settlement with `porPersona` null but a fund figure: the headline sum must not add a fund as if it were a per-person amount; such a row shows "fund" wording and is excluded from the "up to $X per person" total.
- Paddle not live (`eligible:false`, no price): the gate renders with the price visible but the buttons explain availability instead of opening a broken checkout; the free number and locked list still work.
- `funnel.json` fails to load or is empty: Paso 2 degrades to the email-only match already shipped (the existing `#missedCard`), never a JS error that blocks the page.
- Duplicate company between the email match and a picked chip (e.g. the email matched Yahoo and the visitor also ticks Yahoo): the settlement appears once, counted once.
- State is only a statutory-note modifier (e.g. California): it must never filter a settlement out, so a visitor who leaves state blank still sees every match.

---

### Task 1: Reconcile counts and emit the funnel dataset

**Files:**
- Modify: `tools/build-settlement-pages.py` (emit `funnel.json`; it already holds `HOY`, the open rows and per-person numbers)
- Modify: `tools/cross-hibp.py` (reconcile the `casos/acuerdos/abiertas` meta it writes into `settlements.json`, or mark which counts are visitor-facing)
- Modify: `index.html` and `es/index.html` (remove the hardcoded `1,614 cases tracked, 307 still open`; bind to the single source)
- Test: `tools/tests/test_funnel_dataset.py` (pytest)

**Interfaces:**
- Produces: `funnel.json` at repo root (served at `/funnel.json`), shape:
  `{ "meta": {"casos": int, "acuerdos": int, "abiertos": int, "maxPorPersona": int}, "open": [{"empresa": str, "slug": str, "porPersona": int|null, "fondo": int|null, "plazo": "YYYY-MM-DD"|null, "sitio": str|null, "hibp": bool}], "chips": [{"empresa": str, "slug": str}] }`
  where `open` is every case with a future deadline (the 14), sorted by deadline, and `chips` is the Paso 2 candidate companies (all `open` plus the highest-paying HIBP-matched companies, deduped, capped at ~16).
- Consumes: the in-memory `indice`/`paginas` already built; `data/hibp-matched.json` for the matched set.

- [ ] **Step 1: Write the failing test** — `test_funnel_dataset.py`: after importing/running the builder's dataset function on a small fixture, assert (a) `meta.casos == len(publishable cases)` and equals the number the hub page prints, (b) every `open` row has a future-or-today `plazo` and a numeric `porPersona` OR `fondo`, (c) `meta.maxPorPersona == max(porPersona over open)`, (d) `chips` are unique by slug and every `open` company is present.
- [ ] **Step 2: Run it to verify it fails** — `cd tools && python3 -m pytest tests/test_funnel_dataset.py -v` → FAIL (function/`funnel.json` not defined).
- [ ] **Step 3: Implement** a `build_funnel(indice, matched, hoy)` helper in `build-settlement-pages.py` returning the dataset dict, and write `funnel.json` next to the other outputs. Reconcile: `meta.casos/acuerdos/abiertos` come from the same `indice` the hub counts use (1,081 / 755 / 14), not from `settlements.json`.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Reconcile visitor copy** — in `cross-hibp.py`, keep `settlements.json.meta` for internal use but ensure nothing visitor-facing reads `2,182`; replace the hardcoded `1,614 cases tracked, 307 still open` in both home files with a placeholder the JS fills from `funnel.json.meta` (e.g. `<span data-fill="casos">…</span> cases tracked, <span data-fill="abiertos">…</span> open now`).
- [ ] **Step 6: Build and eyeball** — `python3 tools/build-settlement-pages.py` then confirm `funnel.json` exists, `meta.casos == 1081`, `len(open) == 14`.
- [ ] **Step 7: Commit** — `git add tools/build-settlement-pages.py tools/cross-hibp.py tools/tests/test_funnel_dataset.py funnel.json index.html es/index.html && git commit -m "feat(funnel): single-source counts + funnel.json dataset"`

### Task 2: Pure matching module

**Files:**
- Create: `funnel-match.js` (plain browser-global + exportable pure functions, no DOM)
- Test: `tests/funnel-match.test.mjs` (node:test)

**Interfaces:**
- Consumes: the email breach set (HIBP names), the matched settlements from `settlements.json.filas`, the open settlements from `funnel.json.open`, the chip selections, the state string, `todayISO`.
- Produces: `selectClaimable({breaches, matched, open, companies, state, todayISO})` → `{ items: [{empresa, slug, porPersona, fondo, plazo, sitio, abierto, source}], totalMax, openCount, hasState }` where `source` is `'email'` or `'company'`, `items` is deduped by slug (email wins over company for the same slug), `totalMax` is the sum of `porPersona` over items that have one (funds excluded), `openCount` is items with a future `plazo`.

- [ ] **Step 1: Write the failing tests** — cases: (a) email matches Yahoo → item with source email, totalMax 25000; (b) company picks CVS (open, porPersona 10) → item source company, openCount 1; (c) same slug from both email and company → one item, counted once; (d) an open row with porPersona null, fondo set → included as item but excluded from totalMax; (e) empty breaches + empty companies → items [], totalMax 0; (f) state passed → hasState true and no item filtered out by it.
- [ ] **Step 2: Run to verify they fail** — `node --test tests/funnel-match.test.mjs` → FAIL (not defined).
- [ ] **Step 3: Implement** `selectClaimable` and its helpers in `funnel-match.js`, exporting for node and attaching to `window` for the browser.
- [ ] **Step 4: Run to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add funnel-match.js tests/funnel-match.test.mjs && git commit -m "feat(funnel): pure claim-matching module with tests"`

### Task 3: Home funnel UI (English) wired to the free match

**Files:**
- Modify: `index.html` (Paso 2 block + number + locked list + gate markup, after the email result and near `#missedCard`)
- Modify: `app.js` (render Paso 2 chips from `funnel.json.chips`, state select, live recompute via `selectClaimable`, fill the number and locked list; load `funnel-match.js` and `funnel.json`)
- Modify: `content.css` is for the written pages; the app's styles are inline in `index.html` — add the funnel styles there (chips, the big number, locked rows, gate), using the existing CSS tokens.
- Test: manual in-browser (no DOM test harness in this project); the logic is covered by Task 2.

**Interfaces:**
- Consumes: `selectClaimable` (Task 2), `funnel.json` (Task 1), the existing `lastEmailResult.breaches`, the existing state-list builder used by `#alertsState`.
- Produces: a `refreshFunnel()` function called from `refreshOfferCard()` alongside `refreshMissed()`, and chip/state change handlers.

- [ ] **Step 1: Markup** — add a `#crosscheckCard` section: Paso 2 (chips container `#funnelChips`, state select `#funnelState`), the hook number (`#funnelTotal`, `#funnelCount`) with the "up to … not a promise" note, and a locked list (`#funnelLocked`, blurred rows) with the gate (two plans: $5 one-time, $3/mo · $30/yr). Hidden until there is an email result.
- [ ] **Step 2: Chips + state** — in `app.js`, build chips from `funnel.json.chips`, reuse the state options builder for `#funnelState`; toggling a chip or changing state recomputes.
- [ ] **Step 3: Compute + render the free number** — `refreshFunnel()` calls `selectClaimable(...)`, writes `totalMax` (as "up to $X") and `openCount`/items length into the headline, and renders the locked (blurred) list from `items` with amounts and company names but no claim links (those are the paid reveal).
- [ ] **Step 4: Degrade safely** — if `funnel.json` fails to load, hide Paso 2 and leave the existing `#missedCard` as-is; never throw.
- [ ] **Step 5: Verify in browser** — serve the repo, run a check with an email that matches (e.g. a seeded breach), tick CVS + Baptist Health, confirm the number updates and the list shows blurred rows; confirm no console errors; screenshot.
- [ ] **Step 6: Commit** — `git add index.html app.js && git commit -m "feat(funnel): Paso 2 cross-check UI and free number (EN)"`

### Task 4: Paddle gate — $5 one-time list unlock and $3/mo · $30/yr monitoring

**Files:**
- Modify: `app.js` (wire the $5 button to a one-time Paddle checkout and reveal the list on success; wire the $3/mo · $30/yr to the existing subscription checkout, adding the annual price)
- Modify: `api/checkout.js` (or the existing checkout endpoint) to serve the new one-time price id for the list unlock, behind the same provider gate
- Modify: `index.html` / `es/index.html` gate copy to show both prices
- Test: node:test for any new pure helper (price selection); manual for the checkout open path (cannot complete a real charge in test)

**Interfaces:**
- Consumes: env vars `PADDLE_PRICE_LIST_UNLOCK` (one-time) and `PADDLE_PRICE_ALERTS_YEAR` (annual), plus the existing `PADDLE_PRICE_*` for the monthly alerts; `paddleReady`, `paddleTheme()`, the existing `startAlertsCheckout` path.
- Produces: `startListUnlock()` and an entitlement reveal: on `checkout.completed` for the list product, reveal `#funnelLocked` (remove blur, show claim links from the matched items) and remember it in `sessionStorage` so a reload within the session stays unlocked.

- [ ] **Step 1: Price plumbing** — add the two price ids to the checkout config read path; when the provider is not Paddle or the price is absent, the button shows the availability message instead of opening a checkout (Review Focus item 3).
- [ ] **Step 2: $5 one-time** — `startListUnlock()` opens the Paddle one-time checkout for `PADDLE_PRICE_LIST_UNLOCK`; on completion reveal the list with the official claim links (reusing `sitioValido`/`sitioExterno`).
- [ ] **Step 3: $3/mo · $30/yr** — extend the alerts checkout to offer the annual price; the monthly path is unchanged.
- [ ] **Step 4: Verify** — with Paddle sandbox env (owner-provided) the checkout opens; without it, the buttons show the availability copy and the free number still works. Screenshot both states if sandbox keys are available; otherwise verify the no-rail state.
- [ ] **Step 5: Commit** — `git add app.js api/ index.html es/index.html && git commit -m "feat(funnel): Paddle gate for $5 list unlock and $30/yr annual"`

### Task 5: Spanish parity

**Files:**
- Modify: `es/index.html` (the Paso 2 / number / locked / gate markup in Spanish)
- Modify: `app.js` (i18n strings for every funnel label in the `es` block, neutral Spanish, tú-form, no voseo)

**Interfaces:**
- Consumes: the same `refreshFunnel()` and handlers; only strings and the ES markup differ.

- [ ] **Step 1: Strings** — add every funnel i18n key to both `en` and `es` dictionaries; ES uses neutral Spanish (tú), amounts via the existing es-CO/USD formatter.
- [ ] **Step 2: ES markup** — mirror the EN `#crosscheckCard` in `es/index.html`.
- [ ] **Step 3: Verify** — switch the home to ES, run a check, confirm Paso 2, the number and the gate all read correctly in Spanish; screenshot.
- [ ] **Step 4: Commit** — `git add es/index.html app.js && git commit -m "feat(funnel): Spanish parity"`

---

## Owner setup (external, required for the paid gate to charge)

These are not code and only the account owner can do them; the funnel's free part ships without them.

1. Paddle domain approval — send the drafted support email to sellers@paddle.com and get am-i-exposed.com approved (the gate stays in "availability" state until then).
2. In Paddle Billing, create/confirm three prices and set their ids as Vercel env vars:
   - `PADDLE_PRICE_LIST_UNLOCK` — one-time, $5, "settlement list unlock".
   - the existing monthly alerts price ($3/mo).
   - `PADDLE_PRICE_ALERTS_YEAR` — subscription, $30/yr.
3. Redeploy so the env vars load.

## Resolved decisions

- Execution: **Native** (implement all tasks in-session, one final review).
- The "$5 see the list" is a **NEW one-time product** (`PADDLE_PRICE_LIST_UNLOCK`), distinct from the existing $5 action-plan report. Confirmed 2026-11-01.
