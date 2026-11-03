// Vercel serverless function: /api/monitor-signup
// Starts a double opt-in subscription to the daily breach alert.
//
// The address arrives in the POST body, never in the query string, and is never
// logged. Nothing is activated here: a pending row is stored with a one-time
// token and a confirmation mail is sent. The row only becomes active when the
// person opens the link (see confirm-subscription.js). The answer is always the
// same { ok: true } so the endpoint cannot be used to find out whether an
// address is already subscribed.

import {
    isAllowedOrigin, rateLimitOk, readBody, sbSelect, sbInsert, sbPatch,
    publicBaseUrl, clientIp, makeLocalLimiter,
} from './_shared.js';
import { normalizeEmail, isValidEmail, planSignup } from './_breach-watch.mjs';
import { sendBreachConfirm } from './_email.js';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Fallback used only when the shared limiter cannot answer, so a database
// blip does not take signups down.
const localLimiter = makeLocalLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS * 1000);

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

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Namespaced so this does not share check-email's Postgres bucket.
    const ip = clientIp(req);
    const shared = await rateLimitOk(`signup:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
    const overLimit = shared === null ? localLimiter(ip) : !shared;

    if (overLimit) {
        res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_SECONDS));
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const body = readBody(req);
    const raw = body?.email;
    // Type check first: normalizeEmail throws on a non-string.
    if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
    }

    const email = normalizeEmail(raw);
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    if (body?.consent !== true) {
        return res.status(400).json({ error: 'Consent required' });
    }

    const lang = body?.lang === 'en' ? 'en' : 'es';

    try {
        const sel = await sbSelect(`breach_watch?email=eq.${encodeURIComponent(email)}&select=id,status`);
        if (!sel.ok) {
            return res.status(500).json({ error: 'Service unavailable' });
        }

        const existing = sel.rows?.[0] || null;
        const plan = planSignup(existing, { email, lang });
        const base = publicBaseUrl(req);

        if (plan.action === 'insert' || plan.action === 'reconfirm') {
            const token = crypto.randomUUID();
            const saved = plan.action === 'insert'
                ? await sbInsert('breach_watch', { ...plan.row, confirm_token: token })
                : await sbPatch(`breach_watch?id=eq.${existing.id}`, { ...plan.patch, confirm_token: token });

            if (!saved.ok) {
                return res.status(500).json({ error: 'Service unavailable' });
            }

            if (base) {
                try {
                    await sendBreachConfirm({
                        to: email,
                        lang,
                        confirmUrl: `${base}/api/confirm-subscription?token=${token}`,
                    });
                } catch (error) {
                    // The row is pending and the person can sign up again, so a
                    // mail failure must not turn into a 500. Name only: the
                    // address and token must not reach a log.
                    console.error('monitor-signup confirm mail error:', error.name);
                }
            }
        }

        // noop sends nothing; every action answers the same.
        return res.status(200).json({ ok: true });
    } catch (error) {
        // Only the error's name: the address must not reach a log.
        console.error('monitor-signup error:', error.name);
        return res.status(500).json({ error: 'Service unavailable' });
    }
}
