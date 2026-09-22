// Vercel serverless function: /api/check-email
// Proxies to HIBP's breach search API.
//
// The email arrives in the POST body, never in the query string, so it is not
// written to Vercel's access logs. The landing page promises the email is not
// stored; putting it in a URL would break that promise.

const HIBP_ENDPOINT = 'https://haveibeenpwned.com/api/v3/breachedaccount';

// Requests from the site that serves this function are always allowed, on any
// domain, so moving to a custom domain needs no change here. This list is only
// for extra origins (a marketing site on another domain, say) and is overridden
// by the ALLOWED_ORIGINS env var, comma separated.
const DEFAULT_ALLOWED_ORIGINS = [];

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Shared limiter, backed by Postgres so the count holds across every Vercel
// instance. Falls back to the in-memory limiter below if Supabase is not
// configured or does not answer, so a database blip cannot take the site down.
const hits = new Map();

function allowedOrigins() {
    const configured = process.env.ALLOWED_ORIGINS;
    if (!configured) return DEFAULT_ALLOWED_ORIGINS;
    return configured.split(',').map(o => o.trim()).filter(Boolean);
}

function isAllowedOrigin(origin, host) {
    if (!origin) return true; // same-origin requests may omit Origin

    // Trust the site serving this function, whatever domain it is reached on.
    // This keeps the check working on a custom domain and on every preview
    // deployment without hardcoding either.
    if (host) {
        try {
            if (new URL(origin).host === host) return true;
        } catch {
            return false; // malformed Origin
        }
    }

    return allowedOrigins().includes(origin);
}

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

// Returns true if allowed, false if over the limit, or null if the shared
// store is unavailable and the caller should fall back.
async function allowedBySharedLimiter(key) {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return null;

    try {
        // Legacy service_role keys are JWTs and are accepted on either header.
        // New-format secret keys (sb_secret_...) are NOT JWTs: sending one as
        // a Bearer token makes the gateway try to parse it and reject it with
        // "Invalid JWT". Those go on the apikey header only.
        const headers = {
            'Content-Type': 'application/json',
            apikey: serviceKey,
        };
        if (serviceKey.startsWith('eyJ')) {
            headers.Authorization = `Bearer ${serviceKey}`;
        }

        const response = await fetch(`${url}/rest/v1/rpc/check_rate_limit`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                p_key: key,
                p_max: RATE_LIMIT_MAX,
                p_window_seconds: RATE_LIMIT_WINDOW_MS / 1000,
            }),
            // Never let a slow database hold the request open.
            signal: AbortSignal.timeout(2000),
        });

        if (!response.ok) {
            console.error('Rate limit RPC failed:', response.status);
            return null;
        }

        const allowed = await response.json();
        return typeof allowed === 'boolean' ? allowed : null;
    } catch (error) {
        console.error('Rate limit RPC error:', error.name);
        return null;
    }
}

function rateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);

    // Keep the map from growing without bound on a long-lived instance.
    if (hits.size > 5000) {
        for (const [key, times] of hits) {
            if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) hits.delete(key);
        }
    }

    return recent.length > RATE_LIMIT_MAX;
}

// Deliberately stricter than a full RFC 5322 parser: it only needs to reject
// input that would waste an HIBP request.
function isValidEmail(email) {
    return typeof email === 'string' &&
        email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = clientIp(req);
    const shared = await allowedBySharedLimiter(ip);
    const overLimit = shared === null ? rateLimited(ip) : !shared;

    if (overLimit) {
        res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_MS / 1000));
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
    const email = body?.email;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    const apiKey = process.env.HIBP_API_KEY;
    if (!apiKey) {
        console.error('HIBP_API_KEY not configured');
        return res.status(500).json({ error: 'Service not configured' });
    }

    try {
        // truncateResponse=false is required to receive BreachDate and
        // DataClasses. HIBP defaults it to true and returns only Name.
        const response = await fetch(
            `${HIBP_ENDPOINT}/${encodeURIComponent(email)}?truncateResponse=false`,
            {
                method: 'GET',
                headers: {
                    'User-Agent': 'Am-I-Exposed-Check',
                    'hibp-api-key': apiKey,
                },
            }
        );

        if (response.status === 404) {
            return res.status(200).json({
                found: false,
                message: 'Email not found in breaches',
            });
        }

        if (response.status === 200) {
            const breaches = await response.json();

            // Return only the fields the UI renders.
            const sanitized = breaches.map(breach => ({
                name: breach.Name,
                title: breach.Title || breach.Name,
                breachDate: breach.BreachDate || null,
                dataClasses: breach.DataClasses || [],
            }));

            // Newest breach first.
            sanitized.sort((a, b) => (b.breachDate || '').localeCompare(a.breachDate || ''));

            return res.status(200).json({
                found: true,
                breachCount: sanitized.length,
                breaches: sanitized,
            });
        }

        if (response.status === 429) {
            return res.status(429).json({ error: 'Rate limited. Please try again later.' });
        }

        if (response.status === 401) {
            console.error('HIBP rejected the API key');
            return res.status(500).json({ error: 'Service not configured' });
        }

        console.error('Unexpected HIBP status:', response.status);
        return res.status(502).json({ error: 'Failed to check email' });
    } catch (error) {
        console.error('HIBP API error:', error);
        return res.status(502).json({ error: 'Failed to check email' });
    }
}

function safeParse(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
