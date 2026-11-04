// Shared helpers for the payment endpoints.
//
// Vercel does not turn a file in /api whose name begins with an underscore
// into a route, so this is a module, not an endpoint.

// Publishable key. Already public in the page source; used only to satisfy the
// apikey header when asking Supabase to identify a user's access token.
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
    || 'sb_publishable_agkPOONNtck7k-an-rpwOg_GTXoo5de';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

// The live_mode a purchase/subscription row must carry to be accepted, by
// provider. Stripe is the only accepted provider now.
//
// Returns null for any other provider (the legacy Mercado Pago / Paddle rows),
// and null never equals a boolean live_mode, so a legacy row can never unlock a
// report in ANY environment. Returning false would have matched the old
// live_mode=false test rows on a preview deploy, which is why this fails closed.
//
// For Stripe: in production only a real-money row counts (true). On a preview a
// test secret key (sk_test_) accepts the test rows it writes (live_mode false);
// a live key would accept only live_mode true.
export function liveModeFor(provider) {
    if (provider !== 'stripe') return null;
    if (process.env.VERCEL_ENV === 'production') return true;
    return (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live');
}

// The site's own origin, used for checkout return URLs. Set explicitly rather
// than derived from the request, so a request arriving on some other host
// cannot send the buyer back somewhere else.
export function publicBaseUrl(req) {
    const configured = process.env.PUBLIC_BASE_URL;
    if (configured) return configured.replace(/\/+$/, '');
    const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
    return host ? `https://${host}` : null;
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

export function isAllowedOrigin(origin, host) {
    if (!origin) return true;
    if (host) {
        try {
            if (new URL(origin).host === host) return true;
        } catch {
            return false;
        }
    }
    const configured = process.env.ALLOWED_ORIGINS;
    if (!configured) return false;
    return configured.split(',').map(o => o.trim()).filter(Boolean).includes(origin);
}

export function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

// In-memory sliding-window fallback for when the shared Postgres limiter
// cannot answer. Each limiter owns a private map. Returns a function that
// takes a key and answers true when that key is over the limit.
export function makeLocalLimiter(max, windowMs) {
    const hits = new Map();
    return function overLimit(key) {
        const now = Date.now();
        const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
        recent.push(now);
        hits.set(key, recent);

        // Keep the map from growing without bound on a long-lived instance.
        if (hits.size > 5000) {
            for (const [k, times] of hits) {
                if (times.every(t => now - t >= windowMs)) hits.delete(k);
            }
        }

        return recent.length > max;
    };
}

export function safeParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

export function readBody(req) {
    return typeof req.body === 'string' ? safeParse(req.body) : req.body;
}

const MAX_BODY_BYTES = 1_000_000;

// Raw request body, for webhook signature checks. The signature covers the exact
// bytes as they arrived, so the body must not be reparsed or reformatted.
// Endpoints that use this set `export const config = { api: { bodyParser: false } }`
// so the stream is still intact when the handler runs.
export function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// The session token, from the Authorization header first and the request body
// second.
//
// The header is where it belongs: request bodies get written down by body
// logging, APM agents and error reporters, which redact Authorization by
// default and know nothing about a field called accessToken. The body is still
// read so a browser holding the previous app.js keeps working through the
// deploy; it can go once nobody is running that copy.
export function tokenFrom(req, body) {
    const header = req.headers.authorization || req.headers.Authorization;
    if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
        const token = header.replace(/^Bearer\s+/i, '').trim();
        if (token) return token;
    }
    return body?.accessToken;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

// Resolves a Supabase access token to a user, by asking Supabase. Never trusts
// anything the browser claims about who it is.
export async function userFromToken(accessToken) {
    const url = process.env.SUPABASE_URL;
    if (!url || !accessToken || typeof accessToken !== 'string') return null;

    try {
        const response = await fetch(`${url}/auth/v1/user`, {
            headers: {
                apikey: SUPABASE_PUBLISHABLE_KEY,
                Authorization: `Bearer ${accessToken}`,
            },
            signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) return null;
        const user = await response.json();
        return user && user.id ? user : null;
    } catch (error) {
        console.error('Token check failed:', error.name);
        return null;
    }
}

// Secret-key headers for PostgREST. New-format keys (sb_secret_*) are not JWTs
// and belong on the apikey header only; the legacy service_role key is a JWT
// and additionally needs Bearer.
function serviceHeaders(extra = {}) {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = { apikey: secret, ...extra };
    if (secret && secret.startsWith('eyJ')) headers.Authorization = `Bearer ${secret}`;
    return headers;
}

function restUrl(path) {
    const url = process.env.SUPABASE_URL;
    if (!url || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    return `${url}/rest/v1/${path}`;
}

// Every call below returns { ok, status, rows } and never throws, so a caller
// can decide for itself what a database failure means. For entitlement that
// always means "no access": failing closed is the only safe direction.
async function rest(path, init) {
    const url = restUrl(path);
    // Log the table only. The query string carries email=eq.<address> and a
    // PostgREST error body can echo the offending key, so neither is logged.
    const table = path.split('?')[0];
    if (!url) return { ok: false, status: 0, rows: [] };

    try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
        const text = await response.text();
        const rows = text ? (safeParse(text) ?? []) : [];
        if (!response.ok) {
            console.error(`Supabase ${init?.method || 'GET'} ${table} failed: ${response.status}`);
        }
        return { ok: response.ok, status: response.status, rows: Array.isArray(rows) ? rows : [rows] };
    } catch (error) {
        console.error(`Supabase ${init?.method || 'GET'} ${table} error: ${error.name}`);
        return { ok: false, status: 0, rows: [] };
    }
}

export function sbSelect(path) {
    return rest(path, { headers: serviceHeaders() });
}

// Rate limiting that holds across every Vercel instance, because the counter
// lives in Postgres rather than in one instance's memory. See
// supabase_rate_limit.sql.
//
// Returns true when the request is allowed, false when it is over the limit,
// and null when the store cannot answer, so the caller can fall back to its
// own in-memory count instead of a database blip taking the site down.
//
// Every endpoint that spends the Have I Been Pwned quota has to come through
// here: that quota is shared by the whole site, and an in-memory limit lets
// one visitor spend it all by being spread across instances.
export async function rateLimitOk(key, max, windowSeconds) {
    const url = process.env.SUPABASE_URL;
    if (!url || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;

    try {
        const response = await fetch(`${url}/rest/v1/rpc/check_rate_limit`, {
            method: 'POST',
            headers: serviceHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                p_key: key,
                p_max: max,
                p_window_seconds: windowSeconds,
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

export function sbInsert(table, row) {
    return rest(table, {
        method: 'POST',
        headers: serviceHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(row),
    });
}

export function sbPatch(pathWithFilter, patch) {
    return rest(pathWithFilter, {
        method: 'PATCH',
        headers: serviceHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(patch),
    });
}
