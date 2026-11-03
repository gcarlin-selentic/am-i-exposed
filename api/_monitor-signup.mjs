// Vercel serverless function: /api/monitor-signup
// Starts a double opt-in subscription to the daily breach alert.
//
// The address arrives in the POST body, never in the query string, and is never
// logged. Nothing is activated here: a pending row is stored with a one-time
// token and a confirmation mail is sent. The row only becomes active when the
// person opens the link (see confirm-subscription.js). The answer is always the
// same { ok: true }, so the response body does not reveal whether an address
// is already subscribed. Response timing does: the noop path (already-active
// address) returns fast, while insert/reconfirm awaits the confirm-mail send,
// so an attacker timing the response can tell an active subscriber apart.
// Accepted for now (the endpoint is rate-limited); equalizing it would need a
// background-send mechanism (e.g. waitUntil), which the zero-dependency
// constraint rules out.

import {
    isAllowedOrigin, rateLimitOk, readBody, sbSelect, sbInsert, sbPatch,
    publicBaseUrl, clientIp, makeLocalLimiter,
} from './_shared.js';
import { normalizeEmail, isValidEmail, planSignup } from './_breach-watch.mjs';
import { sendBreachConfirm } from './_email.js';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Minimum gap between confirmation mails to the same address.
const THROTTLE_MS = 15 * 60 * 1000;

// Fallback used only when the shared limiter cannot answer, so a database
// blip does not take signups down.
const localLimiter = makeLocalLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS * 1000);

export async function handleSignup(req, res) {
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
        const sel = await sbSelect(`breach_watch?email=eq.${encodeURIComponent(email)}&select=id,status,confirm_sent_at`);
        if (!sel.ok) {
            return res.status(500).json({ error: 'Service unavailable' });
        }

        const row = sel.rows?.[0] || null;
        const plan = planSignup(row, { email, lang });
        const base = publicBaseUrl(req);

        // Sends the confirm mail. A throw counts as a failed send: the row is
        // pending and retryable, so a mail failure must not become a 500.
        // Name only on error: the address and token must not reach a log.
        const trySend = async (token) => {
            try {
                return !!(await sendBreachConfirm({
                    to: email,
                    lang,
                    confirmUrl: `${base}/api/confirm-subscription?token=${token}`,
                }));
            } catch (error) {
                console.error('monitor-signup confirm mail error:', error.name);
                return false;
            }
        };

        if (plan.action === 'insert') {
            // The unique index on email serializes concurrent inserts, so the
            // insert itself is the atomic claim of the first send.
            const token = crypto.randomUUID();
            const ins = await sbInsert('breach_watch', {
                ...plan.row,
                confirm_token: token,
                confirm_sent_at: new Date().toISOString(),
            });
            if (!ins.ok) {
                return res.status(500).json({ error: 'Service unavailable' });
            }
            if (base) {
                // Release the slot on a failed send so it stays retryable.
                if (!(await trySend(token))) {
                    await sbPatch(`breach_watch?id=eq.${ins.rows?.[0]?.id}`, { confirm_sent_at: null });
                }
            } else {
                console.error('monitor-signup: no base url; confirm mail skipped');
            }
        } else if (plan.action === 'reconfirm') {
            const token = crypto.randomUUID();
            const nowIso = new Date().toISOString();
            const cutoffIso = new Date(Date.now() - THROTTLE_MS).toISOString();
            // Claim the send slot atomically: update only if it is free
            // (never sent, or sent before the window). The patch returns the
            // updated rows, so claim.rows is non-empty only if we won.
            const claim = await sbPatch(
                `breach_watch?id=eq.${row.id}&or=(confirm_sent_at.is.null,confirm_sent_at.lt.${encodeURIComponent(cutoffIso)})`,
                { ...plan.patch, confirm_token: token, confirm_sent_at: nowIso }
            );
            if (!claim.ok) {
                return res.status(500).json({ error: 'Service unavailable' });
            }
            // Throttled, or another request won the race: send nothing and
            // leave the earlier link valid.
            if (claim.rows && claim.rows.length > 0) {
                if (base) {
                    if (!(await trySend(token))) {
                        await sbPatch(`breach_watch?id=eq.${row.id}`, { confirm_sent_at: row.confirm_sent_at ?? null });
                    }
                } else {
                    console.error('monitor-signup: no base url; confirm mail skipped');
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
