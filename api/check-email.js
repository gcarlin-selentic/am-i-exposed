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

// Best-effort in-memory limiter. Vercel may run several instances, so this
// bounds abuse per instance rather than globally. Durable limiting needs a
// shared store (Vercel KV, Upstash, or Supabase).
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
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

    if (rateLimited(clientIp(req))) {
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
