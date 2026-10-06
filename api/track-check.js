// Counts a password check.
//
// It needs its own endpoint because that check never reaches this server: the
// browser asks api.pwnedpasswords.com directly, sending five characters of a
// hash, which is what keeps the password on the visitor's device. The server
// therefore cannot know the check happened unless the page says so.
//
// Email checks are not counted here. api/check-email.js counts those itself,
// where the outcome is known first-hand rather than claimed by the caller.
//
// Which means the numbers this endpoint produces are softer than those ones:
// anyone can call it and inflate the password tally. It is rate limited by
// origin to make that tedious, and the honest summary is that these are usage
// figures, not an audited count. Nothing it accepts identifies anybody, and
// no row is written per visit, so inflating it buys only a wrong number.

import { recordCheck } from './_stats.js';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
    return req.headers['x-real-ip'] || 'unknown';
}

// Reuses the counter the email check already relies on. The IP is hashed into
// a key that lives for a minute and is never stored beside anything else; the
// privacy policy describes exactly this.
async function withinRateLimit(req) {
    const url = process.env.SUPABASE_URL;
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !secret) return true;

    const headers = { apikey: secret, 'Content-Type': 'application/json' };
    if (secret.startsWith('eyJ')) headers.Authorization = `Bearer ${secret}`;

    try {
        const response = await fetch(`${url}/rest/v1/rpc/check_rate_limit`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                p_key: `track:${clientIp(req)}`,
                p_max: RATE_LIMIT_MAX,
                p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
            }),
            signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) return true;
        return (await response.json()) !== false;
    } catch (error) {
        // A limiter that is down must not take the feature with it.
        return true;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string'
        ? (() => { try { return JSON.parse(req.body); } catch { return null; } })()
        : req.body;

    const resultado = body?.resultado;
    if (resultado !== 'expuesto' && resultado !== 'limpio') {
        return res.status(400).json({ error: 'Invalid result' });
    }

    if (!(await withinRateLimit(req))) {
        return res.status(429).json({ error: 'Too many requests' });
    }

    // 204 first, because the page has nothing to do with the answer. Then the
    // count is awaited: the response is already out, so nobody is waiting on
    // it, and the invocation lives long enough for the write to complete.
    res.status(204).end();
    return recordCheck({
        lang: body?.lang,
        tipo: 'contrasena',
        resultado,
        origen: body?.origen,
    });
}
