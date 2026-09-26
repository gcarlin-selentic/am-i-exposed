// Vercel serverless function: /api/checkout
//
// GET  returns the price, so the page never hardcodes an amount or a currency.
// POST creates a Mercado Pago preference and returns the URL to send the
//      buyer to.
//
// The amount is read from the environment on both paths. It is never accepted
// from the browser: a price in the request body is a price the buyer can edit.
//
// Note there is deliberately no notification_url on the preference. The
// webhook is registered in the Mercado Pago panel instead, which is what makes
// the notifications arrive signed. See api/mp-webhook.js.

import {
    MP_API,
    credentialOwnerId,
    expectLiveMode,
    isAllowedOrigin,
    mpMode,
    priceConfig,
    publicBaseUrl,
    readBody,
    sbInsert,
    userFromToken,
} from './_shared.js';

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const hits = new Map();

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) {
        for (const [k, times] of hits) {
            if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) hits.delete(k);
        }
    }
    return recent.length > RATE_LIMIT_MAX;
}

const ITEM_TEXT = {
    es: {
        title: 'Plan de acción personalizado',
        description: 'Tu plan completo, paso a paso, con 30 días de acceso.',
    },
    en: {
        title: 'Personalised action plan',
        description: 'Your full step-by-step plan, with 30 days of access.',
    },
};

function pickLang(value) {
    return value === 'es' ? 'es' : 'en';
}

// Normally the webhook is registered in the Mercado Pago panel, which is what
// makes notifications arrive signed. With the test credentials the panel's
// registration never fires: the preference is created under the application
// Mercado Pago generates for the test seller, not the one the panel shows, so
// no notification is produced for a test payment at all.
//
// Setting this puts the URL on the preference instead, which Mercado Pago
// documents as taking priority over the panel. Whether those notifications
// carry x-signature is not documented, and api/mp-webhook.js rejects an
// unsigned one either way, so this can only ever add a notification, never
// weaken the check. Left unset, nothing changes.
function notificationUrl() {
    const configured = process.env.MP_NOTIFICATION_URL;
    return configured ? configured.trim() : null;
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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();

    const price = priceConfig();

    // GET: what the report costs. The page asks for this on load to fill in the
    // offer card, so the amount lives in exactly one place.
    if (req.method === 'GET') {
        if (!price) return res.status(200).json({ available: false });
        return res.status(200).json({
            available: true,
            amount: price.amount,
            currency: price.currency,
            mode: mpMode(),
        });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (rateLimited(clientIp(req))) {
        res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_MS / 1000));
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const accessToken = process.env.MP_ACCESS_TOKEN;
    const base = publicBaseUrl(req);
    if (!accessToken || !price || !base) {
        console.error('Checkout not configured:', { token: !!accessToken, price: !!price, base: !!base });
        return res.status(503).json({ error: 'Payment is not available right now' });
    }

    const body = readBody(req);
    const lang = pickLang(body?.lang);

    // A purchase has to belong to an account, because that is what the
    // entitlement hangs off. Anonymous checkout would take the money and have
    // nobody to give access to.
    const user = await userFromToken(body?.accessToken);
    if (!user) return res.status(401).json({ error: 'Sign in first' });

    const text = ITEM_TEXT[lang];

    const notifyUrl = notificationUrl();

    let preference;
    try {
        const response = await fetch(`${MP_API}/checkout/preferences`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                // Lets Mercado Pago collapse a double click into one preference
                // instead of two.
                'X-Idempotency-Key': `pref-${user.id}-${Math.floor(Date.now() / 60000)}`,
            },
            body: JSON.stringify({
                items: [{
                    id: 'report-30d',
                    title: text.title,
                    description: text.description,
                    category_id: 'services',
                    quantity: 1,
                    unit_price: price.amount,
                    currency_id: price.currency,
                }],
                payer: { email: user.email },
                // The webhook maps a payment back to an account through this.
                external_reference: user.id,
                // lang rides along so the receipt can be written in the
                // language the buyer was actually reading. It comes back on the
                // payment, which saves a column on purchases and a migration.
                metadata: { user_id: user.id, lang },
                back_urls: {
                    success: `${base}/?pago=ok`,
                    failure: `${base}/?pago=error`,
                    pending: `${base}/?pago=pendiente`,
                },
                auto_return: 'approved',
                statement_descriptor: 'AMIEXPOSED',
                ...(notifyUrl ? { notification_url: notifyUrl } : {}),
            }),
            signal: AbortSignal.timeout(8000),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            // Which account the stored token belongs to, and whether a
            // notification_url was attached. Both are what a wrong environment
            // variable gets wrong, and neither is a secret: the owner id is
            // public in every preference Mercado Pago returns.
            console.error('Preference creation failed:', response.status,
                JSON.stringify(payload).slice(0, 400),
                JSON.stringify({ mode: mpMode(), owner: credentialOwnerId(),
                    notify: !!notifyUrl, base }));
            return res.status(502).json({ error: 'Could not open the checkout right now' });
        }
        preference = payload;
    } catch (error) {
        console.error('Preference creation error:', error.name);
        return res.status(502).json({ error: 'Could not open the checkout right now' });
    }

    // Recorded as pending so an abandoned checkout is still visible. The
    // webhook is what turns this into access; if this insert fails the webhook
    // still has external_reference to work from, so it is not worth failing the
    // purchase over.
    const inserted = await sbInsert('purchases', {
        user_id: user.id,
        email: user.email,
        status: 'pending',
        provider: 'mercadopago',
        provider_preference_id: preference.id,
        amount: price.amount,
        currency: price.currency,
        live_mode: expectLiveMode(),
    });
    if (!inserted.ok) console.error('Pending purchase not recorded for', user.id);

    // With test credentials Mercado Pago returns a separate sandbox URL. Using
    // the live one there sends the buyer to a checkout the test cards cannot
    // pay.
    const checkoutUrl = mpMode() === 'test'
        ? (preference.sandbox_init_point || preference.init_point)
        : preference.init_point;

    if (!checkoutUrl) {
        console.error('Preference has no checkout URL:', preference.id);
        return res.status(502).json({ error: 'Could not open the checkout right now' });
    }

    return res.status(200).json({ checkoutUrl, preferenceId: preference.id });
}
