// Vercel serverless function: /api/monitor-signup
// Subscribes an address to the daily breach alert.
//
// The address arrives in the POST body, never in the query string, and is never
// logged. The answer is always the same { ok: true } so the endpoint cannot be
// used to find out whether an address is already subscribed.

import { isAllowedOrigin, rateLimitOk, readBody, sbSelect, sbInsert, sbPatch } from './_shared.js';
import { normalizeEmail, isValidEmail, planSignup } from './_breach-watch.mjs';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Fallback used only when the shared limiter cannot answer, so a database
// blip does not take signups down.
const hits = new Map();

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
    const now = Date.now();
    const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
    const recent = (hits.get(ip) || []).filter(t => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);

    if (hits.size > 5000) {
        for (const [key, times] of hits) {
            if (times.every(t => now - t >= windowMs)) hits.delete(key);
        }
    }

    return recent.length > RATE_LIMIT_MAX;
}

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

    const ip = clientIp(req);
    const shared = await rateLimitOk(ip, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
    const overLimit = shared === null ? rateLimited(ip) : !shared;

    if (overLimit) {
        res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_SECONDS));
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const body = readBody(req);
    const raw = body?.email;
    if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
    }

    const email = normalizeEmail(raw);
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    if (body?.consent !== true) {
        return res.status(400).json({ error: 'Consent is required' });
    }

    try {
        const found = await sbSelect(`breach_watch?email=eq.${encodeURIComponent(email)}&select=id,status`);
        if (!found.ok) {
            return res.status(500).json({ error: 'Failed to subscribe' });
        }

        const plan = planSignup(found.rows[0] || null, { email, lang: body.lang });

        if (plan.action === 'insert') {
            const saved = await sbInsert('breach_watch', plan.row);
            if (!saved.ok) {
                return res.status(500).json({ error: 'Failed to subscribe' });
            }
        } else if (plan.action === 'reactivate') {
            const saved = await sbPatch(`breach_watch?id=eq.${found.rows[0].id}`, plan.patch);
            if (!saved.ok) {
                return res.status(500).json({ error: 'Failed to subscribe' });
            }
        }

        return res.status(200).json({ ok: true });
    } catch (error) {
        // Only the error's name: the address must not reach a log.
        console.error('monitor-signup error:', error.name);
        return res.status(500).json({ error: 'Failed to subscribe' });
    }
}
