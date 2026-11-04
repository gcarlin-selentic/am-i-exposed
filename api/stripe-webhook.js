// Vercel serverless function: /api/stripe-webhook
//
// Stripe's events, verified and turned into entitlement. bodyParser is off so
// the raw bytes are intact for the signature check. Fails closed: no signing
// secret is 503, a bad signature is 400, nothing is written for either.
//
// Security posture (money path):
//  - A one-time report is granted only when payment_status is 'paid' (or
//    'no_payment_required'); an async method that completes unpaid grants
//    nothing until async_payment_succeeded.
//  - An event whose livemode does not match this deployment is ignored, so a
//    test event cannot write a production entitlement.
//  - Subscription status is read from the AUTHORITATIVE subscription fetched
//    live from Stripe, not from the (possibly stale or out-of-order) event, so
//    a replayed invoice.paid can never re-activate a canceled subscription.
//  - A row already bound to a DIFFERENT active subscription is not overwritten.
//  - Refunds and disputes revoke the report.
//
// Idempotent throughout; Stripe retries until a 2xx. Never logs an email/token.

export const config = { api: { bodyParser: false } };

import { readRawBody, sbSelect, sbInsert, sbPatch, liveModeFor } from './_shared.js';
import { verifyStripeSignature, monitorStatus } from './_stripe.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const isoFromUnix = (sec) =>
    typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
const clean = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
};

async function stripeGet(path) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    try {
        const r = await fetch(`https://api.stripe.com/v1/${path}`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(8000),
        });
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

// Grant/refresh a monitor subscription from the live Stripe subscription, so
// out-of-order or replayed events converge on the current state. `email` (from
// the checkout session) is needed only to first bind a row; later events match
// by subscription id.
async function applySubscription(subId, email) {
    if (!subId) return;
    const sub = await stripeGet(`subscriptions/${encodeURIComponent(subId)}`);
    if (!sub) return; // cannot verify right now; Stripe retries

    const item = sub.items?.data?.[0];
    const fields = clean({
        status: monitorStatus(sub.status),
        plan: sub.metadata?.plan,
        lang: sub.metadata?.lang === 'es' ? 'es' : (sub.metadata?.lang === 'en' ? 'en' : undefined),
        bill_interval: item?.price?.recurring?.interval || null,
        current_period_end: isoFromUnix(sub.current_period_end),
        live_mode: !!sub.livemode,
        stripe_customer_id: sub.customer || null,
        stripe_subscription_id: subId,
    });
    const now = new Date().toISOString();

    // Once bound, the subscription id is the stable key.
    const bySub = await sbSelect(
        `breach_watch?stripe_subscription_id=eq.${encodeURIComponent(subId)}&select=id`
    );
    if (bySub.rows?.length) {
        await sbPatch(`breach_watch?id=eq.${bySub.rows[0].id}`, { ...fields, updated_at: now });
        return;
    }

    // Not bound yet: bind by the checkout email.
    const addr = lc(email || sub.metadata?.email);
    if (!addr) return; // checkout.session.completed carries the email and will bind it

    const byEmail = await sbSelect(
        `breach_watch?email=eq.${encodeURIComponent(addr)}&select=id,status,stripe_subscription_id`
    );
    const row = byEmail.rows?.[0];
    if (row) {
        // Ownership guard: never hijack a row already tied to a different active sub.
        if (row.stripe_subscription_id && row.stripe_subscription_id !== subId && row.status === 'active') {
            console.error('stripe-webhook: email already bound to a different active subscription; skipping');
            return;
        }
        await sbPatch(`breach_watch?id=eq.${row.id}`, { ...fields, updated_at: now });
    } else {
        await sbInsert('breach_watch', { email: addr, baseline_done: false, ...fields });
    }
}

// Record the one-time report, only on a genuinely paid session. Idempotent by
// the payment id so a retry cannot grant a second window.
async function grantReport(session, liveMode) {
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    if (!paid) return;
    const email = lc(session.customer_details?.email || session.customer_email);
    if (!email) return;
    const payId = session.payment_intent || session.id;
    const dup = await sbSelect(`purchases?provider_payment_id=eq.${encodeURIComponent(payId)}&select=id`);
    if (dup.rows?.length) return;
    await sbInsert('purchases', {
        email,
        status: 'paid',
        provider: 'stripe',
        provider_payment_id: payId,
        provider_preference_id: session.id,
        amount: (session.amount_total ?? 0) / 100,
        currency: (session.currency || 'usd').toUpperCase(),
        live_mode: liveMode,
        paid_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
}

// Revoke a report when its payment is refunded or disputed. Matched by the
// payment intent; a non-report charge (e.g. a subscription invoice) simply
// matches no row.
async function revokeByPaymentIntent(paymentIntentId, status) {
    if (!paymentIntentId) return;
    await sbPatch(
        `purchases?provider_payment_id=eq.${encodeURIComponent(paymentIntentId)}&status=eq.paid`,
        { status, updated_at: new Date().toISOString() }
    );
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook not configured' });

    let raw;
    try {
        raw = await readRawBody(req);
    } catch {
        return res.status(400).json({ error: 'Bad body' });
    }

    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], secret)) {
        return res.status(400).json({ error: 'Invalid signature' });
    }

    let event;
    try {
        event = JSON.parse(raw.toString('utf8'));
    } catch {
        return res.status(400).json({ error: 'Bad JSON' });
    }

    // A test-mode event must not write a production entitlement, and vice versa.
    // liveModeFor('stripe') is the live_mode this deployment accepts.
    if (!!event.livemode !== liveModeFor('stripe')) {
        return res.status(200).json({ ignored: 'livemode mismatch' });
    }

    const liveMode = !!event.livemode;
    const obj = event.data?.object || {};

    try {
        switch (event.type) {
            case 'checkout.session.completed':
            case 'checkout.session.async_payment_succeeded': {
                if (obj.mode === 'subscription') {
                    await applySubscription(obj.subscription, lc(obj.customer_details?.email || obj.customer_email));
                } else if (obj.mode === 'payment' && obj.metadata?.plan === 'report') {
                    await grantReport(obj, liveMode);
                }
                break;
            }

            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted': {
                await applySubscription(obj.id);
                break;
            }

            case 'invoice.paid':
            case 'invoice.payment_failed': {
                if (obj.subscription) await applySubscription(obj.subscription);
                break;
            }

            case 'charge.refunded': {
                await revokeByPaymentIntent(obj.payment_intent, 'refunded');
                break;
            }

            case 'charge.dispute.created': {
                await revokeByPaymentIntent(obj.payment_intent, 'disputed');
                break;
            }

            default:
                break;
        }
    } catch (error) {
        // 500 so Stripe retries; every write above is idempotent.
        console.error('stripe-webhook handler error:', error.name);
        return res.status(500).json({ error: 'handler error' });
    }

    return res.status(200).json({ received: true });
}
