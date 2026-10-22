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

// Whether a purchase row from this provider was made with real money.
//
// One flag was enough while Mercado Pago was the only seller: live_mode
// meant MP_MODE. With two, it means something different per row. Mercado
// Pago's environment is MP_MODE; Paddle's is written into its own client
// token, test_ or live_. The two move independently, and they already have:
// Mercado Pago is live in production while Paddle is still in sandbox, so
// a real Paddle purchase and a test one are told apart by Paddle's setting,
// not by Mercado Pago's.
//
// Comparing every row against MP_MODE is what made a paid Paddle report
// read as unpaid: the buyer saw their own confirmation and then the
// padlocks, because the browser matched on one rule and the server on
// another.
export function liveModeFor(provider) {
    // On the live site, only a purchase made with real money counts, full
    // stop. Matching each row against its provider's current setting is the
    // right rule for a preview deployment, where everything is a test, and
    // the wrong one here: with Paddle in sandbox it resolves to false, which
    // is exactly what a sandbox purchase writes, so a test card bought the
    // paid report for nothing. Hiding the offer card did not fix that. The
    // checkout can still be opened by anyone holding the sandbox price id,
    // and that id was public, served by /api/checkout to every visitor in
    // the United States for days.
    //
    // There are five paid rows carrying live_mode false in the database. This
    // is what stops them, and anything like them, from unlocking a report.
    if (process.env.VERCEL_ENV === 'production') return true;

    if (provider === 'paddle') {
        return (process.env.PADDLE_CLIENT_TOKEN || '').startsWith('live_');
    }
    return mpMode() === 'live';
}

// The account the deployment's credentials belong to. A Mercado Pago access
// token ends in the id of its owner, so this needs no API call.
//
// This is what separates a test payment from a real one now. Mercado Pago's own
// live_mode flag no longer does it: the modern test credentials belong to a
// test user who is a real account as far as their API is concerned, so a
// sandbox payment comes back with live_mode true. The collector does not lie —
// a payment made to the other set of credentials simply has a different one.
export function credentialOwnerId() {
    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) return null;
    const tail = token.split('-').pop();
    return /^\d+$/.test(tail) ? tail : null;
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

// Where the visitor is, as Vercel's edge sees it. Not a header a browser can
// forge: Vercel overwrites whatever arrives with its own value.
//
// Used to decide which payment provider a visitor is offered. Mercado Pago
// settles in soles and does not operate in the United States; Paddle is the
// merchant of record there and charges in dollars. Sending a buyer in Miami
// to a checkout that says S/ 19 costs the sale, and sending a buyer in Lima
// to one that says $5 charges them a foreign transaction fee.
//
// Absent on a local request, which therefore falls through to Mercado Pago.
// That is the right default: it is the path that has been taking real money
// for weeks.
export function isUnitedStates(req) {
    return req?.headers?.['x-vercel-ip-country'] === 'US';
}

// Paddle's client-side tokens are prefixed test_ in sandbox and live_ in
// production, so the environment is read off the token rather than kept as a
// second setting that can disagree with it.
export function paddleConfig(priceEnv) {
    const token = process.env.PADDLE_CLIENT_TOKEN;
    const priceId = process.env[priceEnv];
    if (!token || !priceId) return null;
    const environment = token.startsWith('test_') ? 'sandbox' : 'production';

    // A sandbox token on the live site is not a configuration, it is a hole.
    // The checkout only takes test cards, so nobody with a real card can pay;
    // and a test card does go through, writing live_mode false, which is
    // exactly what the entitlement check in report.js accepts. So the report
    // is free to anyone who notices.
    //
    // Read off the token rather than kept as a switch somebody has to
    // remember to flip: the offer comes back by itself the day the live token
    // is set, with no second deploy and nothing left behind to clean up.
    if (environment === 'sandbox' && process.env.VERCEL_ENV === 'production') {
        return null;
    }

    return { token, priceId, environment };
}

// Cuanto cuesta el reporte en dolares, solo para mostrarlo. Fuera de Estados
// Unidos el cobro lo hace Mercado Pago en soles y eso no cambia: este numero
// no se le pasa nunca a la pasarela, solo lo pinta la pagina en ingles, donde
// "S/ 19" no le dice nada a nadie. Si no esta puesto, la pagina en ingles
// sigue mostrando el precio real en soles, que es la respuesta segura.
export function usdReference() {
    const amount = Number(process.env.REPORT_USD_PRICE);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
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
