// Called by a Supabase Database Webhook when a row lands in auth.users, which
// is the only moment a free account exists.
//
// Why a webhook and not a call from the page: sign-up happens in the browser,
// talking to Supabase directly, so there is no server of ours in that path. An
// endpoint the browser calls after signing up would work, and would also let
// anyone with curl fill the CRM with addresses that never signed up for
// anything. This fires from Supabase's side instead, and carries a secret the
// browser never sees.

import { syncSignup } from './_zoho.js';
import { readBody } from './_shared.js';

// Compared in constant time. A plain === leaks the shared secret a character
// at a time to anyone patient enough to measure the response.
function secretMatches(given) {
    const expected = process.env.SUPABASE_HOOK_SECRET;
    if (!expected || !given) return false;

    const a = Buffer.from(String(given));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;

    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!secretMatches(req.headers['x-hook-secret'])) {
        // Deliberately says nothing about whether the secret is unset here or
        // merely wrong.
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const payload = readBody(req) || {};

    // Supabase sends { type, table, schema, record, old_record }. Only a fresh
    // row is a new account; an update is a password change, a confirmation, a
    // sign-in timestamp, none of which is a new customer.
    if (payload.type !== 'INSERT' || payload.table !== 'users') {
        return res.status(200).json({ ok: true, skipped: 'not an insert on users' });
    }

    const record = payload.record || {};
    const email = record.email;
    if (!email) {
        return res.status(200).json({ ok: true, skipped: 'no email' });
    }

    // Set by the page when the account is created, so the CRM knows which
    // language to write to this person in. Absent on an account made any other
    // way, and Spanish is the site's default.
    const lang = record.raw_user_meta_data?.lang === 'en' ? 'en' : 'es';

    await syncSignup({ email, lang, createdAt: record.created_at });

    // Always 200 on a payload we understood. Supabase retries a failure, and a
    // CRM that was briefly unreachable is not a reason to be sent the same
    // sign-up again and again: syncSignup has already logged and swallowed it.
    return res.status(200).json({ ok: true });
}
