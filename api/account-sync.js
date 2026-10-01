// Tells the CRM that an account exists, which is something our own server
// otherwise never learns: sign-up and sign-in happen in the browser, against
// Supabase, with nothing of ours in the path.
//
// The page calls this once a session is established. That is browser-initiated
// but not browser-trusted: the only thing accepted is an access token, which is
// handed to Supabase to resolve. Somebody posting a made-up token gets a 401,
// so this cannot be used to put strangers' addresses into the CRM.
//
// What deliberately does not appear anywhere here is an address being checked.
// This endpoint receives a token and nothing else, so there is no point at
// which a visitor's query and their account could be put side by side.

import { userFromToken, readBody, sbSelect } from './_shared.js';
import { syncUserOnce } from './_zoho.js';

// Same test as the report's: a paid row, for this deployment's Mercado Pago
// credentials, that has not run out. Repeated here rather than imported
// because api/report.js is a route, not a module.
async function hasActiveAccess(userId) {
    if (!userId) return false;

    const liveMode = process.env.MP_MODE === 'live';
    const path = 'purchases?select=expires_at'
        + `&user_id=eq.${encodeURIComponent(userId)}`
        + '&status=eq.paid'
        + `&live_mode=eq.${liveMode}`
        + `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(new Date().toISOString())})`
        + '&limit=1';

    const { ok, rows } = await sbSelect(path);
    // Failing closed here would mean treating a database hiccup as "unpaid"
    // and writing a free record over a buyer's. Failing open means skipping
    // the push, and the webhook has already written the row that matters.
    return ok ? rows.length > 0 : true;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = readBody(req) || {};
    const user = await userFromToken(body.accessToken);
    if (!user) return res.status(401).json({ error: 'Sign in first' });

    const paid = await hasActiveAccess(user.id);
    await syncUserOnce(user, { paid, lang: body.lang });

    // Says nothing about what was or was not written. The page has no use for
    // it, and a caller probing for whether an account already exists in the
    // CRM would learn nothing either.
    return res.status(200).json({ ok: true });
}
