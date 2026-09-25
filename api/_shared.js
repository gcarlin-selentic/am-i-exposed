// Shared helpers for the payment endpoints.
//
// Vercel does not turn a file in /api whose name begins with an underscore
// into a route, so this is a module, not an endpoint.

export const MP_API = 'https://api.mercadopago.com';

// Publishable key. Already public in the page source; used only to satisfy the
// apikey header when asking Supabase to identify a user's access token.
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
    || 'sb_publishable_agkPOONNtck7k-an-rpwOg_GTXoo5de';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

// 'test' while the Mercado Pago test credentials are in use, 'live' once the
// real ones are. Test and real purchases share one Supabase table, so this is
// what keeps them from being confused for one another: it decides which
// checkout URL the browser is sent to, which notifications are accepted, and
// which purchase rows grant access.
export function mpMode() {
    return process.env.MP_MODE === 'live' ? 'live' : 'test';
}

export function expectLiveMode() {
    return mpMode() === 'live';
}

// The site's own origin, used for the checkout's return URLs. Set explicitly
// rather than derived from the request, so a request arriving on some other
// host cannot send the buyer back somewhere else.
export function publicBaseUrl(req) {
    const configured = process.env.PUBLIC_BASE_URL;
    if (configured) return configured.replace(/\/+$/, '');
    const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
    return host ? `https://${host}` : null;
}

// The price lives on the server. If the browser could name the amount, the
// report could be bought for one sol.
export function priceConfig() {
    const amount = Number(process.env.MP_PRICE);
    const currency = (process.env.MP_CURRENCY || '').trim().toUpperCase();
    if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) return null;
    return { amount, currency };
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

export function safeParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

export function readBody(req) {
    return typeof req.body === 'string' ? safeParse(req.body) : req.body;
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
    if (!url) return { ok: false, status: 0, rows: [] };

    try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
        const text = await response.text();
        const rows = text ? (safeParse(text) ?? []) : [];
        if (!response.ok) {
            console.error(`Supabase ${init?.method || 'GET'} ${path} failed:`, response.status, text.slice(0, 200));
        }
        return { ok: response.ok, status: response.status, rows: Array.isArray(rows) ? rows : [rows] };
    } catch (error) {
        console.error(`Supabase ${init?.method || 'GET'} ${path} error:`, error.name);
        return { ok: false, status: 0, rows: [] };
    }
}

export function sbSelect(path) {
    return rest(path, { headers: serviceHeaders() });
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
