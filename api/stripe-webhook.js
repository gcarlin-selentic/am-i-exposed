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
//  - An event whose livemode does not match this deployment is ignored.
//  - Subscription status is read from the AUTHORITATIVE subscription fetched
//    live from Stripe, so a replayed/out-of-order invoice.paid cannot
//    re-activate a canceled subscription. A cancellation (subscription.deleted)
//    is applied straight from the signed event, so a revocation is never lost
//    to a fetch failure.
//  - A row is rebound to a new subscription by email only when it is unbound or
//    belongs to the same Stripe customer, so one buyer cannot take over
//    another's row by typing their address.
//  - Refunds and disputes revoke the report.
//  - Every Supabase call is checked: a failed read/write throws, so the handler
//    returns 500 and Stripe redelivers rather than silently dropping the change.
//
// Idempotent throughout. Never logs an email/token.

export const config = { api: { bodyParser: false } };

import { readRawBody, sbSelect, sbInsert, sbPatch, liveModeFor } from './_shared.js';
import { verifyStripeSignature, monitorStatus } from './_stripe.mjs';
import { sendBreachConfirm } from './_email.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const isoFromUnix = (sec) =>
    typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
const clean = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
};

// A Supabase call that must succeed. sbSelect/sbInsert/sbPatch never throw and
// return { ok }; an unchecked failure would read as "no rows"/"done" and drop
// the write. Throwing makes the handler answer 500 so Stripe redelivers.
function must(result, what) {
    if (!result || !result.ok) throw new Error(`db ${what} failed`);
    return result;
}

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
    // Could not verify: throw so Stripe redelivers rather than losing the change
    // (e.g. a past_due/cancel we must apply).
    if (!sub) throw new Error('subscription fetch failed');

    const item = sub.items?.data?.[0];
    const lang = sub.metadata?.lang === 'es' ? 'es' : 'en';
    // Stripe's state goes to sub_status. The email-confirmation lifecycle
    // (status) is set to 'pending' only on a fresh bind and never touched by a
    // routine event, so a webhook can neither auto-confirm nor un-unsubscribe.
    const subFields = clean({
        sub_status: monitorStatus(sub.status),
        plan: sub.metadata?.plan,
        lang,
        bill_interval: item?.price?.recurring?.interval || null,
        current_period_end: isoFromUnix(sub.current_period_end),
        live_mode: !!sub.livemode,
        stripe_customer_id: sub.customer || null,
        stripe_subscription_id: subId,
    });
    const now = new Date().toISOString();

    // Already bound: update the subscription state only. If the address never
    // confirmed, (re)send the confirmation so a failed first send is recovered
    // when Stripe redelivers this event.
    const bySub = must(await sbSelect(
        `breach_watch?stripe_subscription_id=eq.${encodeURIComponent(subId)}&select=id,email,status,confirm_token`
    ), 'select by sub');
    if (bySub.rows?.length) {
        const r = bySub.rows[0];
        must(await sbPatch(`breach_watch?id=eq.${r.id}`, { ...subFields, updated_at: now }), 'patch by sub');
        if (r.status === 'pending') {
            const token = r.confirm_token || crypto.randomUUID();
            if (!r.confirm_token) {
                must(await sbPatch(`breach_watch?id=eq.${r.id}`, { confirm_token: token, confirm_sent_at: now }), 'set token');
            }
            await sendConfirmOrThrow(r.email, lang, token);
        }
        return;
    }

    // Not bound yet: bind by the checkout email.
    const addr = lc(email || sub.metadata?.email);
    if (!addr) return; // checkout.session.completed carries the email and will bind it

    const byEmail = must(await sbSelect(
        `breach_watch?email=eq.${encodeURIComponent(addr)}&select=id,status,confirm_token,stripe_subscription_id,stripe_customer_id`
    ), 'select by email');
    const row = byEmail.rows?.[0];

    if (row) {
        // Rebind only when the row is unbound or belongs to the SAME customer,
        // so a buyer cannot take over someone else's address by typing it.
        const sameCustomer = row.stripe_customer_id && sub.customer && row.stripe_customer_id === sub.customer;
        if (row.stripe_subscription_id && row.stripe_subscription_id !== subId && !sameCustomer) {
            console.error('stripe-webhook: email bound to a different subscription/customer; skipping');
            return;
        }
        if (row.status === 'active') {
            // Address already confirmed: bind the subscription, no re-confirm.
            must(await sbPatch(`breach_watch?id=eq.${row.id}`, { ...subFields, updated_at: now }), 'patch active by email');
        } else {
            // New or previously unsubscribed: require (re)confirmation first.
            const token = crypto.randomUUID();
            must(await sbPatch(`breach_watch?id=eq.${row.id}`, {
                ...subFields, status: 'pending', confirm_token: token, confirm_sent_at: now, confirmed_at: null, updated_at: now,
            }), 'patch pending by email');
            await sendConfirmOrThrow(addr, lang, token);
        }
    } else {
        const token = crypto.randomUUID();
        must(await sbInsert('breach_watch', {
            email: addr, baseline_done: false, ...subFields,
            status: 'pending', confirm_token: token, confirm_sent_at: now,
        }), 'insert pending');
        await sendConfirmOrThrow(addr, lang, token);
    }
}

// The confirmation mail is required before any alert is sent, so the inbox owner
// (not whoever typed the address at checkout) activates monitoring. A send
// failure throws, so Stripe redelivers and the bind-by-sub path above resends
// the same token until it lands.
async function sendConfirmOrThrow(email, lang, token) {
    const base = (process.env.PUBLIC_BASE_URL || 'https://www.am-i-exposed.com').replace(/\/+$/, '');
    let ok = false;
    try {
        ok = !!(await sendBreachConfirm({
            to: email,
            lang: lang === 'es' ? 'es' : 'en',
            confirmUrl: `${base}/api/confirm-subscription?token=${token}`,
        }));
    } catch (error) {
        console.error('confirm mail error:', error.name);
        ok = false;
    }
    if (!ok) throw new Error('confirm mail failed');
}

// Cancellation, applied straight from the signed event. One-way and safe, so it
// does not depend on a live fetch and can never be lost to a fetch failure.
async function cancelSubscription(subId, periodEndUnix) {
    if (!subId) return;
    must(await sbPatch(
        `breach_watch?stripe_subscription_id=eq.${encodeURIComponent(subId)}`,
        { status: 'canceled', current_period_end: isoFromUnix(periodEndUnix), updated_at: new Date().toISOString() }
    ), 'cancel');
}

// Record the one-time report, only on a genuinely paid session. Idempotent by
// the payment id so a retry cannot grant a second window.
async function grantReport(session, liveMode) {
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    if (!paid) return;
    const email = lc(session.customer_details?.email || session.customer_email);
    if (!email) return;
    const payId = session.payment_intent || session.id;

    // Authoritative refund/dispute check. A completion event can arrive (or be
    // redelivered) after the charge was already refunded or disputed, racing the
    // revocation. Re-read the payment intent from Stripe and refuse to grant if
    // the money is no longer held, so a late grant cannot resurrect a refunded
    // report. A fetch failure throws, so Stripe redelivers rather than granting
    // blind. (no_payment_required has no payment intent, so nothing to re-check.)
    if (session.payment_intent) {
        const pi = await stripeGet(`payment_intents/${encodeURIComponent(session.payment_intent)}?expand[]=latest_charge`);
        if (!pi) throw new Error('payment intent fetch failed');
        if (pi.status !== 'succeeded') return;
        const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
        if (charge && (charge.refunded || charge.amount_refunded > 0 || charge.disputed)) return;
    }

    const dup = must(await sbSelect(`purchases?provider_payment_id=eq.${encodeURIComponent(payId)}&select=id`), 'report dup check');
    if (dup.rows?.length) return;
    must(await sbInsert('purchases', {
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
    }), 'report insert');
}

// Revoke a report when its payment is refunded or disputed. Matched by the
// payment intent; a non-report charge simply matches no row (still a 2xx).
async function revokeByPaymentIntent(paymentIntentId, status) {
    if (!paymentIntentId) return;
    must(await sbPatch(
        `purchases?provider_payment_id=eq.${encodeURIComponent(paymentIntentId)}&status=eq.paid`,
        { status, updated_at: new Date().toISOString() }
    ), 'revoke');
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
            case 'customer.subscription.updated': {
                await applySubscription(obj.id);
                break;
            }

            case 'customer.subscription.deleted': {
                await cancelSubscription(obj.id, obj.current_period_end);
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
