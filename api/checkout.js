// Vercel serverless function: /api/checkout
//
// POST { plan } (or ?plan=) creates a Stripe Checkout Session and returns its
// url; the browser redirects there. One rail, Stripe, for everyone, in USD.
//
// The price is never accepted from the browser: the plan names a server-side
// env var (STRIPE_PRICE_*) that holds the real price id, so a price in the
// request body is ignored. An unconfigured plan (e.g. a gated one whose price
// id is not set) returns 503, never a broken checkout.
//
// mode is 'payment' for the one-time report and 'subscription' for monitoring.
// The entitlement plan (report|breach|settlement|combo) rides in the session
// metadata, and on a subscription also in subscription_data.metadata, so the
// webhook can act on it without re-reading the line items.

import {
    isAllowedOrigin, clientIp, makeLocalLimiter, rateLimitOk, readBody, publicBaseUrl,
} from './_shared.js';
import { planSpec, priceIdFor, toForm } from './_stripe.mjs';

const STRIPE_SESSIONS = 'https://api.stripe.com/v1/checkout/sessions';
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const localLimiter = makeLocalLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS * 1000);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;

    if (!isAllowedOrigin(origin, host)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const ip = clientIp(req);
    const shared = await rateLimitOk(`checkout:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
    if (shared === null ? localLimiter(ip) : !shared) {
        res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_SECONDS));
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const body = readBody(req) || {};
    const planParam = req.query?.plan || body.plan;
    const spec = planSpec(planParam);
    if (!spec) return res.status(400).json({ error: 'Unknown plan' });

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return res.status(503).json({ error: 'Payments not configured' });

    const price = priceIdFor(planParam);
    // A plan whose price id is not set is intentionally unavailable (e.g. a
    // gated tier). 503, not a checkout that cannot charge.
    if (!price) return res.status(503).json({ error: 'This plan is not available yet' });

    const base = publicBaseUrl(req) || 'https://www.am-i-exposed.com';
    const lang = body.lang === 'es' ? 'es' : 'en';
    const email = typeof body.email === 'string' && EMAIL_RE.test(body.email.trim())
        ? body.email.trim().toLowerCase()
        : null;

    const meta = { plan: spec.plan, plan_param: planParam, lang };
    const form = toForm({
        mode: spec.mode,
        'line_items[0][price]': price,
        'line_items[0][quantity]': 1,
        success_url: `${base}/?checkout=success&plan=${encodeURIComponent(spec.plan)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/?checkout=cancel`,
        customer_email: email,
        allow_promotion_codes: true,
        metadata: meta,
        // Carry the plan onto the subscription (payment) object too, so the
        // subscription.* / payment_intent.* events can act without a lookup.
        ...(spec.mode === 'subscription'
            ? { subscription_data: { metadata: meta } }
            : { payment_intent_data: { metadata: meta } }),
    });

    try {
        const r = await fetch(STRIPE_SESSIONS, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${secret}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form,
            signal: AbortSignal.timeout(10000),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok || !data?.url) {
            // Status only: the Stripe error body can echo the email.
            console.error('checkout: stripe session create failed', r.status);
            return res.status(502).json({ error: 'Could not start checkout' });
        }
        return res.status(200).json({ url: data.url });
    } catch (error) {
        console.error('checkout error:', error.name);
        return res.status(502).json({ error: 'Could not start checkout' });
    }
}
