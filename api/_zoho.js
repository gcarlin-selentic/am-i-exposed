// Pushing customers into Selentic's Zoho CRM.
//
// Vercel does not turn a file in /api whose name begins with an underscore
// into a route, so this is a module, not an endpoint.
//
// Two things reach the CRM, and nothing else: somebody created an account, and
// somebody paid. What a visitor's address turned up in never comes here. The
// privacy policy says a checked address is not stored, and a count of
// somebody's breaches sitting in a CRM record would make that untrue.
//
// Nothing in here may be allowed to fail a payment or a sign-up. Every call is
// awaited so the serverless function does not exit mid-flight, and every
// failure is swallowed after being logged. A CRM that missed a row is a
// nuisance; a payment that failed because a CRM was down is a lost sale.

const ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';

// Contacts, for everyone. The owner chose to skip the Lead stage: these are
// people who already signed up for something, not names to qualify.
const MODULE = 'Contacts';

// The access token lives an hour. Vercel reuses a warm instance across
// invocations, so holding it here turns most pushes into one request instead
// of two. A cold start simply fetches a new one.
let cached = { token: null, apiDomain: null, expiresAt: 0 };

function configured() {
    return Boolean(process.env.ZOHO_CLIENT_ID
        && process.env.ZOHO_CLIENT_SECRET
        && process.env.ZOHO_REFRESH_TOKEN);
}

// The refresh response carries api_domain, which is why the data centre is not
// hardcoded: an org on zoho.eu and one on zoho.com are told apart by Zoho
// itself rather than by us guessing from an env var.
async function accessToken() {
    if (cached.token && Date.now() < cached.expiresAt) return cached;

    const params = new URLSearchParams({
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token',
    });

    const response = await fetch(`${ACCOUNTS_URL}/oauth/v2/token?${params}`, {
        method: 'POST',
        signal: AbortSignal.timeout(4000),
    });
    const data = await response.json().catch(() => ({}));

    // Zoho answers 200 with an error body when a refresh token has been
    // revoked, so the status alone does not say whether this worked.
    if (!response.ok || !data.access_token) {
        throw new Error(`Zoho token refresh failed: ${data.error || response.status}`);
    }

    cached = {
        token: data.access_token,
        apiDomain: data.api_domain || 'https://www.zohoapis.com',
        // A minute of margin, so a token does not expire between this check
        // and the request that uses it.
        expiresAt: Date.now() + ((Number(data.expires_in) || 3600) - 60) * 1000,
    };
    return cached;
}

// Zoho needs a Last_Name on every contact and we have no name to give it: the
// free check asks for nothing, and creating an account asks only for an
// address. The local part is the closest thing to a name the person has handed
// over, and it is what they would recognise in a list.
function nameFromEmail(email) {
    const local = String(email).split('@')[0] || '';
    return local.slice(0, 80) || String(email).slice(0, 80);
}

// Upsert rather than create, keyed on the address: somebody who signs up and
// then pays is one person, and the paid push has to land on the row the
// sign-up made rather than beside it.
//
// Description is rewritten on each push, deliberately. The paid state
// supersedes the free one, and Zoho's own Created Time already records when
// the contact first appeared, so nothing worth keeping is lost.
async function upsert(fields) {
    const { token, apiDomain } = await accessToken();

    const response = await fetch(`${apiDomain}/crm/v8/${MODULE}/upsert`, {
        method: 'POST',
        headers: {
            'Authorization': `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            data: [fields],
            duplicate_check_fields: ['Email'],
        }),
        // Bounded like every other outbound call here. This one runs inside
        // the checkout request, so a slow CRM must not become a buyer staring
        // at a button that never opens Mercado Pago.
        signal: AbortSignal.timeout(5000),
    });

    const body = await response.json().catch(() => ({}));
    const result = body.data?.[0];

    if (!response.ok || result?.code !== 'SUCCESS') {
        throw new Error(`Zoho upsert failed: ${result?.code || response.status}`);
    }
    return result.action; // 'insert' or 'update'
}

function describe(lines) {
    return ['am-i-exposed.com', ...lines].join('\n');
}

function langLabel(lang) {
    return lang === 'en' ? 'Ingles' : 'Espanol';
}

// Accounts already pushed by this warm instance. This is the cheap half of
// the guard and not the one that matters: each route is its own function with
// its own instance, so three of them pushed the same person into Zoho three
// times on the first real purchase. The durable half is below.
const seen = new Set();

// Written on the Supabase user once the push has happened, and read back on
// every later request through user_metadata, which userFromToken already
// returns. A Set in memory cannot do this job: it does not survive a cold
// start and is not shared between routes.
async function markSynced(userId) {
    const url = process.env.SUPABASE_URL;
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !secret || !userId) return;

    const headers = { apikey: secret, 'Content-Type': 'application/json' };
    if (secret.startsWith('eyJ')) headers.Authorization = `Bearer ${secret}`;

    try {
        await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ user_metadata: { zoho_synced: true } }),
            signal: AbortSignal.timeout(4000),
        });
    } catch (error) {
        // Worst case the mark is missed and this person is pushed again on a
        // later request, which Zoho's upsert turns into an update.
        console.error('Could not mark the account as synced:', error.name);
    }
}

// Called when a signed-in visitor reaches the server, which is the first moment
// our own code learns that an account exists: sign-up happens in the browser,
// against Supabase, with nothing of ours in the path.
//
// `paid` decides whether this runs at all. The payment webhook writes the
// authoritative record, with the amount and the date, and this one knows
// neither; letting it run over a buyer would replace that with "cuenta
// gratuita". So a paying customer is left to the webhook and skipped here.
// Returns true only when this account is known to be in the CRM, either
// because it was just put there or because it was already marked.
//
// It used to return nothing, and the endpoint above it answered 200 either
// way. The browser took that as done and wrote a permanent "already
// announced" mark, so every account that signed in during the weeks the
// Zoho client was dead was recorded as synced and would never be sent
// again. A silent failure that erases its own evidence is worse than a loud
// one, and this is what the caller needs to tell them apart.
export async function syncUserOnce(user, { paid, lang } = {}) {
    // Nothing to do, and nothing to retry either: the purchase path writes
    // the authoritative record for a buyer, and an unconfigured CRM has
    // nowhere to put anybody.
    if (paid) return true;
    if (!configured() || !user?.email) return false;

    // Already in, durably. Worth saying so, or the browser keeps asking.
    if (user.user_metadata?.zoho_synced) return true;

    // Another request for this account is already in flight on this
    // instance. Not done, and not this request's to claim.
    if (seen.has(user.id)) return false;

    seen.add(user.id);
    // A warm instance never approaches this; the cap is only here so a very
    // long-lived one cannot grow the set without bound.
    if (seen.size > 2000) seen.clear();

    const ok = await syncSignup({
        email: user.email,
        lang: user.user_metadata?.lang || lang,
        createdAt: user.created_at,
    });
    if (!ok) {
        // Let the next visit try again rather than leaving the account
        // stranded on this instance's memory of a failure.
        seen.delete(user.id);
        return false;
    }
    await markSynced(user.id);
    return true;
}

// Called when somebody creates an account. There is no payment yet and may
// never be one.
export async function syncSignup({ email, lang, createdAt }) {
    if (!configured() || !email) return;

    try {
        const when = createdAt ? new Date(createdAt).toISOString().slice(0, 10) : null;
        const action = await upsert({
            Email: email,
            Last_Name: nameFromEmail(email),
            Description: describe([
                'Cuenta gratuita',
                `Idioma: ${langLabel(lang)}`,
                when ? `Registro: ${when}` : null,
            ].filter(Boolean)),
        });
        console.log(`Zoho signup sync: ${action}`);
        return true;
    } catch (error) {
        console.error('Zoho signup sync failed:', error.message);
        return false;
    }
}

// Called from the Mercado Pago webhook, on a real transition to paid. A
// repeated notification returns before reaching here, so nobody is written
// twice for one purchase.
export async function syncPurchase({ email, lang, amount, currency, paidAt }) {
    if (!configured() || !email) return;

    try {
        const when = paidAt ? new Date(paidAt).toISOString().slice(0, 10) : null;
        const price = amount != null && currency
            ? `${Number(amount).toFixed(2)} ${currency}`
            : null;

        const action = await upsert({
            Email: email,
            Last_Name: nameFromEmail(email),
            Description: describe([
                'Plan de accion pagado',
                `Idioma: ${langLabel(lang)}`,
                price ? `Pago: ${price}` : null,
                when ? `Fecha de pago: ${when}` : null,
            ].filter(Boolean)),
        });
        console.log(`Zoho purchase sync: ${action}`);
    } catch (error) {
        console.error('Zoho purchase sync failed:', error.message);
    }
}
