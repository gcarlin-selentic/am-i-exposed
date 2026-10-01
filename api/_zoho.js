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

    const response = await fetch(`${ACCOUNTS_URL}/oauth/v2/token?${params}`, { method: 'POST' });
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
    } catch (error) {
        console.error('Zoho signup sync failed:', error.message);
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
