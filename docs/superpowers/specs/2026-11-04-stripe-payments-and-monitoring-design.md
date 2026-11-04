# Stripe payments + paid monitoring - design (2026-11-04)

Owner: Guillermo Carlin (personal, US merchant). Goal: ONE payment rail (Stripe),
remove Mercado Pago + Paddle, and deliver all paid monitoring (breach, settlement,
combo). Supersedes the Paddle/MoR plan and the auth-based wave2 settlement design.

## Catalog (USD)
- FREE: one-time email check (breaches now + on-page settlement matches). No ongoing alerts.
- Full report: $5 one-time (existing `purchases` flow, 30-day access).
- Breach monitoring: $3/mo, $30/yr - ongoing; alert when a NEW breach matches the email.
- Settlement monitoring: $3/mo, $30/yr - ongoing; alert when a new US data-breach settlement opens the subscriber may be able to claim.
- Combo: $5/mo, $50/yr - both.

Stripe TEST price ids already created (report, breach mo/yr, settlement mo/yr, combo mo/yr);
live recreated at go-live. Price `metadata.plan` drives entitlement.

## Rail: Stripe only (no MoR)
- `api/checkout.js`: build a Stripe Checkout Session for `?plan=...` (mode=payment for the
  report, mode=subscription for the rest), success/cancel URLs, prefill `customer_email`,
  metadata `{plan, lang, breaches}`. Prices from env `STRIPE_PRICE_*`. Return `session.url`,
  client redirects. No price ever accepted from the browser.
- `api/stripe-webhook.js` (new): verify the `Stripe-Signature` with manual HMAC-SHA256
  (no `stripe` SDK, matching the repo's dependency-free style). Handle:
  - `checkout.session.completed` (payment) -> `purchases` paid row (report; existing flow).
  - `checkout.session.completed` (subscription) -> upsert the monitor row, status active.
  - `customer.subscription.updated` / `deleted`, `invoice.paid` / `invoice.payment_failed`
    -> update status + current_period_end.
- Remove: `_paddle.js`, `paddle-webhook.js`, `paddle-webhook-sandbox.js`, `mp-webhook.js`,
  all `MP_*` / `PADDLE_*` env, and the MP/Paddle branches in `checkout.js`, `_shared.js`,
  `report.js`, `_alerts-config.mjs`. Stripe serves everyone (geo-branch gone).
- No publishable key (hosted Checkout redirect only).

## Subscriber model: email-based, unified in `breach_watch`
Reuse `breach_watch` as the single paid-monitor table (it has 0 real rows today and
already carries `known_breaches`, `baseline_done`, `lang`, `unsubscribe_token`, `status`).
- ALTER add: `stripe_customer_id text`, `stripe_subscription_id text`, `bill_interval text`,
  `current_period_end timestamptz`, `live_mode boolean not null default false`, and
  `sub_status text` (the Stripe subscription state, kept separate from `status`).
- `plan` now one of `breach | settlement | combo`. The free double opt-in signup is RETIRED
  (monitoring is paid via Stripe); the confirm/unsubscribe pages are REUSED for the paid flow.
- **Two separate states** (decided 2026-11-04, owner chose to keep the confirm step):
  `status` is the email-confirmation lifecycle (pending -> active via the confirm link, or
  unsubscribed); `sub_status` is the Stripe subscription state (active/past_due/canceled).
  A routine Stripe event writes only `sub_status`, never `status`, so a webhook can neither
  auto-confirm an unverified address nor un-unsubscribe one.
- Activation: a paid subscription binds the row as `status='pending'` with a confirm token
  and sends a confirmation email; the inbox owner clicks it (`/api/confirm-subscription`,
  existing `_confirm.mjs`) to become `status='active'`. This closes the "pay for an address
  you don't own" vector. A failed confirm send throws so Stripe redelivers and the token is
  resent. `known_breaches` is seeded by the breach run's baseline on the first run.
- Alerts require BOTH `status='active'` (confirmed) AND `sub_status='active'` (paying), plus
  the plan and the environment's `live_mode`.
- Breach daily run (`api/_run-alerts.mjs`): reads
  `status=active & sub_status=active & plan in (breach,combo) & live_mode=eq.<env>`.
  `processSubscribers` unchanged (baseline welcome + new-breach alert; updates
  `known_breaches`/`baseline_done`).
- Settlement daily run (new, adapted from the wave2 `_settlement-alerts.mjs`, email-keyed):
  `status=active AND plan in (settlement, combo)`; `selectForSubscriber` over
  `data/open-settlements.json`; Brevo email; dedup via `settlement_alerts_sent` (email-keyed).
  Combo is ONE row, read by both runs.
- Trigger: the existing Radar GitHub Action POSTs both runs with `Bearer CRON_SECRET`
  (no Vercel cron; Hobby is at its 2-cron cap). Add `op=run-settlements` to `api/monitor.js`.

## Schema (DDL, via Supabase connector; project morosdhhoznicppmrqyr)
1. `ALTER TABLE breach_watch ADD COLUMN stripe_customer_id text, ADD COLUMN stripe_subscription_id text, ADD COLUMN bill_interval text, ADD COLUMN current_period_end timestamptz, ADD COLUMN live_mode boolean NOT NULL DEFAULT false;`
2. `CREATE TABLE settlement_alerts_sent (id bigint generated always as identity primary key, email text not null, settlement_id text not null, live_mode boolean not null default false, sent_at timestamptz not null default now());`
   `CREATE UNIQUE INDEX settlement_alerts_sent_once ON settlement_alerts_sent (email, settlement_id, live_mode);`
   `ALTER TABLE settlement_alerts_sent ENABLE ROW LEVEL SECURITY;` (no policies: service-role only).

## Entitlement
- Report: `purchases` paid row -> `report.js` unlocks (existing).
- Monitoring: `breach_watch` active row drives both runs. Offer cards gate on a rewritten
  `/api/alerts-config` (Stripe configured + the plan's price present). Keep US-first copy
  (product is US-centric) but no hard geo-block, since Stripe serves everyone.

## Sequencing
1. Stripe backend (checkout + webhook + entitlement) + remove MP/Paddle. Test mode.
2. Settlement run (adapt wave2) + DDL + Radar trigger.
3. Front-end: buy buttons -> `/api/checkout?plan=...`; USD pricing; remove MP/Paddle client.
4. Funnel redesign (result-takeover, money headline, Money Pool page) layered after, with mockups.

## Tests (node:test; TDD on money-critical)
- Stripe webhook signature verification (valid, tampered, wrong secret, replay/timestamp).
- price->plan mapping; event->entitlement mapping.
- Reuse the wave2 settlement selection/email tests (email-keyed).
- Breach plan filter.

## Legal
- Seller identity: the site's legal/privacy/terms name Selentic S.A.C.; change to the
  personal/Stripe setup. Keep "we only inform and link to official claim sites; not lawyers;
  no guaranteed money" everywhere.
