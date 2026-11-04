// Vercel serverless function: /api/stripe-webhook
//
// Stripe's events, verified and turned into entitlement. bodyParser is off so
// the raw bytes are intact for the signature check (the signature covers the
// exact body; reparsing it would break it). Fails closed: no signing secret is
// 503, a bad signature is 400, and nothing is written for either.
//
// Idempotent on purpose. Stripe retries until it gets a 2xx, and sends events
// out of order, so every write is a conditional upsert: a one-time report is
// skipped if its payment is already recorded, and a subscription row is matched
// by its stripe id (or created from the checkout session that carries the email).
//
// Never logs an email or a token: only an error's name.

export const config = { api: { bodyParser: false } };

import { readRawBody, sbSelect, sbInsert, sbPatch } from './_shared.js';
import { verifyStripeSignature, monitorStatus } from './_stripe.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function lc(s) {
    return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

function isoFromUnix(sec) {
    return typeof sec === 'number' && Number.isFinite(sec)
        ? new Date(sec * 1000).toISOString()
        : null;
}

// breach_watch is the single email-keyed monitor table. Create it on the
// checkout session (which carries the email), update it later by stripe id.
async function upsertMonitorByEmail(email, fields) {
    if (!email) return;
    const sel = await sbSelect(`breach_watch?email=eq.${encodeURIComponent(email)}&select=id`);
    const now = new Date().toISOString();
    const row = sel.rows?.[0];
    if (row) {
        await sbPatch(`breach_watch?id=eq.${row.id}`, { ...fields, updated_at: now });
    } else {
        await sbInsert('breach_watch', { email, baseline_done: false, ...fields });
    }
}

async function updateMonitorBySubscription(subId, fields) {
    if (!subId) return;
    await sbPatch(
        `breach_watch?stripe_subscription_id=eq.${encodeURIComponent(subId)}`,
        { ...fields, updated_at: new Date().toISOString() }
    );
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

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

    const liveMode = !!event.livemode;
    const obj = event.data?.object || {};

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const email = lc(obj.customer_details?.email || obj.customer_email);
                const plan = obj.metadata?.plan;
                const lang = obj.metadata?.lang === 'es' ? 'es' : 'en';

                if (obj.mode === 'payment' && plan === 'report') {
                    const payId = obj.payment_intent || obj.id;
                    // Idempotent: a retry must not grant a second report window.
                    const dup = await sbSelect(
                        `purchases?provider_payment_id=eq.${encodeURIComponent(payId)}&select=id`
                    );
                    if (email && !dup.rows?.length) {
                        await sbInsert('purchases', {
                            email,
                            status: 'paid',
                            provider: 'stripe',
                            provider_payment_id: payId,
                            provider_preference_id: obj.id,
                            amount: (obj.amount_total ?? 0) / 100,
                            currency: (obj.currency || 'usd').toUpperCase(),
                            live_mode: liveMode,
                            paid_at: new Date().toISOString(),
                            expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
                        });
                    }
                } else if (obj.mode === 'subscription' && plan) {
                    await upsertMonitorByEmail(email, {
                        plan,
                        status: 'active',
                        lang,
                        live_mode: liveMode,
                        stripe_customer_id: obj.customer || null,
                        stripe_subscription_id: obj.subscription || null,
                    });
                }
                break;
            }

            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const item = obj.items?.data?.[0];
                const fields = {
                    status: monitorStatus(obj.status),
                    current_period_end: isoFromUnix(obj.current_period_end),
                    bill_interval: item?.price?.recurring?.interval || null,
                    live_mode: liveMode,
                };
                // Keep the entitlement plan in sync if the subscription carries it.
                if (obj.metadata?.plan) fields.plan = obj.metadata.plan;
                await updateMonitorBySubscription(obj.id, fields);
                break;
            }

            case 'customer.subscription.deleted': {
                await updateMonitorBySubscription(obj.id, {
                    status: 'canceled',
                    current_period_end: isoFromUnix(obj.current_period_end),
                });
                break;
            }

            case 'invoice.payment_failed': {
                if (obj.subscription) {
                    await updateMonitorBySubscription(obj.subscription, { status: 'past_due' });
                }
                break;
            }

            case 'invoice.paid': {
                if (obj.subscription) {
                    await updateMonitorBySubscription(obj.subscription, {
                        status: 'active',
                        current_period_end: isoFromUnix(obj.lines?.data?.[0]?.period?.end),
                    });
                }
                break;
            }

            default:
                break;
        }
    } catch (error) {
        // Return 500 so Stripe retries; every write above is idempotent.
        console.error('stripe-webhook handler error:', error.name);
        return res.status(500).json({ error: 'handler error' });
    }

    return res.status(200).json({ received: true });
}
