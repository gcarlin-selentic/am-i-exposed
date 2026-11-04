// Pure Stripe helpers: webhook signature verification, plan<->price mapping, and
// form-encoding for the REST API. No I/O, so this is unit-tested on its own
// (api/_stripe.test.mjs). The endpoints (checkout.js, stripe-webhook.js) do the
// fetch/Supabase wiring and call into here.
//
// We talk to Stripe over raw REST with fetch and verify the webhook signature by
// hand, so the project keeps its zero-dependency shape (no `stripe` SDK), the
// same way _shared.js already does.

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Webhook signature (Stripe-Signature: "t=1700000000,v1=abc,v1=def")
// ---------------------------------------------------------------------------

// The signed payload is "<t>.<raw body bytes>"; v1 is its HMAC-SHA256 keyed by
// the endpoint's signing secret. Several v1 can appear during a secret rotation,
// so any one matching is a match.
export function parseStripeSig(header) {
    if (typeof header !== 'string') return null;
    let t = null;
    const v1 = [];
    for (const part of header.split(',')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === 't') t = value;
        else if (key === 'v1') v1.push(value);
    }
    return t && v1.length ? { t, v1 } : null;
}

function timingEqualHex(expected, actual) {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(actual, 'utf8');
    // timingSafeEqual throws on a length mismatch, which is itself a mismatch.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Verifies the Stripe-Signature over the exact raw body. Fails closed on a
// missing secret or a malformed header. A timestamp outside the tolerance is
// rejected (replay protection); Stripe signs each retry freshly, so late
// retries still carry a fresh t. nowSec/toleranceSec are injectable for tests.
export function verifyStripeSignature(rawBody, sigHeader, secret, opts = {}) {
    if (!secret) return false;
    const parsed = parseStripeSig(sigHeader);
    if (!parsed) return false;

    const tNum = Number(parsed.t);
    if (!Number.isFinite(tNum)) return false;

    const toleranceSec = opts.toleranceSec ?? 300;
    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (toleranceSec > 0 && Math.abs(nowSec - tNum) > toleranceSec) return false;

    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const expected = crypto
        .createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${parsed.t}.`, 'utf8'), body]))
        .digest('hex');

    return parsed.v1.some(sig => timingEqualHex(expected, sig));
}

// ---------------------------------------------------------------------------
// Plan <-> price mapping
// ---------------------------------------------------------------------------

// The ?plan= query values the checkout accepts, each mapped to the env var that
// holds its Stripe price id, the Checkout mode, and the entitlement plan. The
// env indirection keeps test and live price ids out of the code.
export const PLANS = {
    report:           { env: 'STRIPE_PRICE_REPORT',           mode: 'payment',      plan: 'report',     interval: null },
    breach_month:     { env: 'STRIPE_PRICE_BREACH_MONTH',     mode: 'subscription', plan: 'breach',     interval: 'month' },
    breach_year:      { env: 'STRIPE_PRICE_BREACH_YEAR',      mode: 'subscription', plan: 'breach',     interval: 'year' },
    settlement_month: { env: 'STRIPE_PRICE_SETTLEMENT_MONTH', mode: 'subscription', plan: 'settlement', interval: 'month' },
    settlement_year:  { env: 'STRIPE_PRICE_SETTLEMENT_YEAR',  mode: 'subscription', plan: 'settlement', interval: 'year' },
    combo_month:      { env: 'STRIPE_PRICE_COMBO_MONTH',      mode: 'subscription', plan: 'combo',       interval: 'month' },
    combo_year:       { env: 'STRIPE_PRICE_COMBO_YEAR',       mode: 'subscription', plan: 'combo',       interval: 'year' },
};

export function planSpec(planParam) {
    return PLANS[planParam] || null;
}

export function priceIdFor(planParam, env = process.env) {
    const spec = PLANS[planParam];
    if (!spec) return null;
    return env[spec.env] || null;
}

// Reverse: a Stripe price id (as it arrives on a webhook line item) back to its
// plan. Returns { mode, plan, interval } or null.
export function planFromPriceId(priceId, env = process.env) {
    if (!priceId) return null;
    for (const spec of Object.values(PLANS)) {
        if (env[spec.env] && env[spec.env] === priceId) {
            return { mode: spec.mode, plan: spec.plan, interval: spec.interval };
        }
    }
    return null;
}

// A Stripe subscription status mapped to the one breach_watch stores. Only
// 'active' is alerted by the daily jobs; past_due is a grace state (Stripe is
// retrying the card), canceled/incomplete stop alerts, paused holds them.
export function monitorStatus(stripeStatus) {
    if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
    if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'past_due';
    if (stripeStatus === 'paused') return 'paused';
    return 'canceled';
}

// ---------------------------------------------------------------------------
// Form encoding for the Stripe REST API
// ---------------------------------------------------------------------------

// Stripe's API takes application/x-www-form-urlencoded with bracket notation for
// nesting (line_items[0][price]=..., metadata[plan]=...). This flattens a plain
// object/array into those keys. null and undefined are dropped so an optional
// field is simply absent. Pre-bracketed keys (passed as strings) are kept as-is.
export function toForm(obj) {
    const params = new URLSearchParams();
    const walk = (prefix, value) => {
        if (value === null || value === undefined) return;
        if (Array.isArray(value)) {
            value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
        } else if (typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) {
                walk(prefix ? `${prefix}[${k}]` : k, v);
            }
        } else {
            params.append(prefix, String(value));
        }
    };
    for (const [k, v] of Object.entries(obj)) walk(k, v);
    return params.toString();
}
