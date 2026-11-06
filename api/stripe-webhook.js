// Vercel serverless function: /api/stripe-webhook
//
// Stripe's events, verified and turned into entitlement. bodyParser is off so
// the raw bytes are intact for the signature check. Fails closed: no signing
// secret is 503, a bad signature is 400, nothing is written for either.
//
// Security posture (money path):
//  - A one-time report is granted only when payment_status is paid (or
//    no_payment_required) AND the payment intent is still succeeded and not
//    refunded/disputed when re-read from Stripe.
//  - An event whose livemode does not match this deployment is ignored.
//  - Subscription status is read from the AUTHORITATIVE subscription fetched
//    live from Stripe and written to sub_status (the paid gate). The email
//    lifecycle (status) is separate: a routine event never touches it, so a
//    webhook can neither auto-confirm nor un-unsubscribe an address.
//  - A paid subscription binds the row as status='pending' and the inbox owner
//    must confirm before any alert is sent. The confirm mail is sent only on a
//    binding event and through an atomic 15-minute throttle, so a retried or
//    duplicated event cannot mail-bomb the address.
//  - A row is rebound to a new subscription only when unbound or the same
//    customer. Refunds/disputes revoke the report.
//  - Every Supabase call is checked: a failure throws, so the handler returns
//    500 and Stripe redelivers rather than silently dropping the change.
//
// Never logs an email/token.

export const config = { api: { bodyParser: false } };

import { readRawBody, sbSelect, sbInsert, sbPatch, liveModeFor, ensureUserMagicLink } from './_shared.js';
import { verifyStripeSignature, monitorStatus } from './_stripe.mjs';
import { sendBreachConfirm, sendReportLink } from './_email.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIRM_THROTTLE_MS = 15 * 60 * 1000;

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

// Atomically claim the right to send a confirmation to this row, throttled so a
// retried or duplicated event cannot mail-bomb the address. Only the slot winner
// sends; a send failure releases the slot and throws so a redelivery retries.
async function sendConfirmThrottled(rowId, email, lang, existingToken) {
    if (!rowId || !email) return;
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - CONFIRM_THROTTLE_MS).toISOString();
    const token = existingToken || crypto.randomUUID();

    const claim = must(await sbPatch(
        `breach_watch?id=eq.${rowId}&or=(confirm_sent_at.is.null,confirm_sent_at.lt.${encodeURIComponent(cutoff)})`,
        { confirm_token: token, confirm_sent_at: now }
    ), 'claim confirm send');
    if (!claim.rows?.length) return; // a confirmation was sent recently; do not spam

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
    if (!ok) {
        // Release the slot so a redelivery can retry, then fail the handler.
        await sbPatch(`breach_watch?id=eq.${rowId}`, { confirm_sent_at: null });
        throw new Error('confirm mail failed');
    }
}

// Grant/refresh a monitor subscription from the live Stripe subscription, so
// out-of-order or replayed events converge on the current state. Stripe state
// goes to sub_status; status is the email-confirmation lifecycle and is set to
// 'pending' only on a fresh bind, never by a routine event. `email` (from the
// checkout session) is needed only to first bind a row. The confirm mail is
// (re)sent only when `sendConfirm` (a binding event), and throttled.
async function applySubscription(subId, email, sendConfirm) {
    if (!subId) return;
    const sub = await stripeGet(`subscriptions/${encodeURIComponent(subId)}`);
    if (!sub) throw new Error('subscription fetch failed');

    const item = sub.items?.data?.[0];
    const lang = sub.metadata?.lang === 'es' ? 'es' : 'en';
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

    // Already bound: update the subscription state only.
    const bySub = must(await sbSelect(
        `breach_watch?stripe_subscription_id=eq.${encodeURIComponent(subId)}&select=id,email,status,confirm_token`
    ), 'select by sub');
    if (bySub.rows?.length) {
        const r = bySub.rows[0];
        must(await sbPatch(`breach_watch?id=eq.${r.id}`, { ...subFields, updated_at: now }), 'patch by sub');
        if (sendConfirm && r.status === 'pending') {
            await sendConfirmThrottled(r.id, r.email, lang, r.confirm_token);
        }
        return;
    }

    // Not bound yet: bind by the checkout email (routine events carry none).
    const addr = lc(email || sub.metadata?.email);
    if (!addr) return;

    const byEmail = must(await sbSelect(
        `breach_watch?email=eq.${encodeURIComponent(addr)}&select=id,status,stripe_subscription_id,stripe_customer_id`
    ), 'select by email');
    const row = byEmail.rows?.[0];

    if (row) {
        // Rebind only when the row is unbound or belongs to the SAME customer.
        const sameCustomer = row.stripe_customer_id && sub.customer && row.stripe_customer_id === sub.customer;
        if (row.stripe_subscription_id && row.stripe_subscription_id !== subId && !sameCustomer) {
            console.error('stripe-webhook: email bound to a different subscription/customer; skipping');
            return;
        }
        if (row.status === 'active') {
            // Already email-confirmed: bind the subscription, no re-confirm.
            must(await sbPatch(`breach_watch?id=eq.${row.id}`, { ...subFields, updated_at: now }), 'patch active by email');
        } else {
            // New or previously unsubscribed: require (re)confirmation first.
            must(await sbPatch(`breach_watch?id=eq.${row.id}`, {
                ...subFields, status: 'pending', confirmed_at: null, updated_at: now,
            }), 'patch pending by email');
            if (sendConfirm) await sendConfirmThrottled(row.id, addr, lang, null);
        }
    } else {
        const ins = must(await sbInsert('breach_watch', {
            email: addr, baseline_done: false, ...subFields, status: 'pending',
        }), 'insert pending');
        const newId = ins.rows?.[0]?.id;
        if (sendConfirm && newId) await sendConfirmThrottled(newId, addr, lang, null);
    }
}

// Cancellation, applied straight from the signed event. Writes sub_status (the
// paid gate the daily jobs read), not status (email confirmation). One-way and
// safe, so it does not depend on a live fetch and is never lost to a fetch error.
async function cancelSubscription(subId, periodEndUnix) {
    if (!subId) return;
    must(await sbPatch(
        `breach_watch?stripe_subscription_id=eq.${encodeURIComponent(subId)}`,
        { sub_status: 'canceled', current_period_end: isoFromUnix(periodEndUnix), updated_at: new Date().toISOString() }
    ), 'cancel');
}

// Record the one-time report, only on a genuinely paid session that is still
// paid (not refunded/disputed) when re-read from Stripe. Idempotent by payment id.
async function grantReport(session, liveMode) {
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    if (!paid) return;
    const email = lc(session.customer_details?.email || session.customer_email);
    if (!email) return;
    const payId = session.payment_intent || session.id;

    // Authoritative refund/dispute check against a completion that races a refund.
    if (session.payment_intent) {
        const pi = await stripeGet(`payment_intents/${encodeURIComponent(session.payment_intent)}?expand[]=latest_charge`);
        if (!pi) throw new Error('payment intent fetch failed');
        if (pi.status !== 'succeeded') return;
        const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
        if (charge && (charge.refunded || charge.amount_refunded > 0 || charge.disputed)) return;
    }

    const dup = must(await sbSelect(`purchases?provider_payment_id=eq.${encodeURIComponent(payId)}&select=id`), 'report dup check');
    if (dup.rows?.length) return;

    // The report is entitled by user_id. A signed-in buyer carried theirs in
    // client_reference_id (checkout.js). A guest did not: we create or link a
    // Supabase account from the paid email and, after recording the purchase
    // under it, mail a magic link that signs them in to reach the report. The
    // provisioning is idempotent, so a Stripe redelivery after a mid-way failure
    // retries cleanly. No link is minted for a signed-in buyer — they are
    // already in their account.
    let userId = session.client_reference_id || null;
    let magic = null;
    if (!userId) {
        const base = (process.env.PUBLIC_BASE_URL || 'https://www.am-i-exposed.com').replace(/\/+$/, '');
        magic = await ensureUserMagicLink(email, `${base}/?plan=1`);
        if (!magic) throw new Error('guest account/link provisioning failed');
        userId = magic.userId;
    }

    must(await sbInsert('purchases', {
        email,
        user_id: userId,
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

    // Guest buyer: mail the magic link. The money is already recorded, so a mail
    // failure must not throw (that would make Stripe redeliver and risk a second
    // mail); log it and leave the row paid. The reply-to in the mail is the
    // fallback if the link is never delivered or expires.
    if (magic) {
        const lang = session.metadata?.lang === 'es' ? 'es' : 'en';
        try {
            await sendReportLink({ to: email, lang, actionLink: magic.actionLink });
        } catch (error) {
            console.error('report link mail error:', error.name);
        }
    }
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
                    await applySubscription(obj.subscription, lc(obj.customer_details?.email || obj.customer_email), true);
                } else if (obj.mode === 'payment' && obj.metadata?.plan === 'report') {
                    await grantReport(obj, liveMode);
                }
                break;
            }

            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                await applySubscription(obj.id, undefined, false);
                break;
            }

            case 'customer.subscription.deleted': {
                await cancelSubscription(obj.id, obj.current_period_end);
                break;
            }

            case 'invoice.paid':
            case 'invoice.payment_failed': {
                if (obj.subscription) await applySubscription(obj.subscription, undefined, false);
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
