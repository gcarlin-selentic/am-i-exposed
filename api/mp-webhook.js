// Vercel serverless function: /api/mp-webhook
//
// The only thing in the system that can grant paid access. Everything here is
// written so that being wrong means granting nothing.
//
// Three rules, in order:
//
//   1. The caller is authenticated before anything else is read, so the
//      endpoint cannot be used to hand out access by posting to it.
//   2. The notification body is never believed. It carries an id; the payment
//      state is then read back from Mercado Pago's own API. A forged body that
//      somehow passed step 1 still cannot claim "approved".
//   3. Access is granted only for a payment whose live_mode matches the
//      credentials this deployment holds, so a test payment cannot unlock the
//      real site and a real one cannot be consumed by the preview.
//
// On rule 1 there are two routes in, because Mercado Pago has two ways of
// notifying and only one of them can be verified:
//
//   - A notification produced by the panel's own registration (Tus
//     integraciones > Webhooks) carries x-signature, an HMAC over a documented
//     manifest keyed by the secret the panel shows. That is checked properly.
//   - A notification produced by a notification_url on the preference also
//     carries x-signature, but measured on 2026-09-25 against nine manifest
//     shapes and both panel secrets, none of them reproduce it. Whatever key
//     signs that route, the panel does not hand it out. And it is the only
//     route that fires at all for a test payment: the panel's registration
//     produced zero notifications for four approved test payments.
//
// So that second route is authenticated by a secret of our own instead:
// MP_NOTIFICATION_TOKEN goes into the notification_url as ?k=..., which only
// travels inside the preference, and only Mercado Pago ever receives it. It is
// a shared secret, weaker than a signature, which is why rules 2 and 3 matter:
// knowing it lets somebody make us re-read a payment, not invent one. Access
// still lands on the account named by the real payment's external_reference,
// never on whoever sent the notification.

import crypto from 'node:crypto';

import {
    MP_API,
    expectLiveMode,
    readBody,
    sbInsert,
    sbPatch,
    sbSelect,
} from './_shared.js';

const ACCESS_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mercado Pago's payment states, mapped onto the ones the purchases table
// allows. Anything still in flight is left alone: the notification for the
// final state will follow.
const STATUS_MAP = {
    approved: 'paid',
    rejected: 'failed',
    cancelled: 'cancelled',
    refunded: 'refunded',
    charged_back: 'refunded',
};

// x-signature looks like: ts=1704908010,v1=618c8534...
function parseSignature(header) {
    if (typeof header !== 'string') return null;
    const parts = {};
    for (const chunk of header.split(',')) {
        const eq = chunk.indexOf('=');
        if (eq === -1) continue;
        parts[chunk.slice(0, eq).trim()] = chunk.slice(eq + 1).trim();
    }
    return parts.ts && parts.v1 ? { ts: parts.ts, v1: parts.v1 } : null;
}

// The template is id:<data.id>;request-id:<x-request-id>;ts:<ts>; with any part
// that is absent dropped from the string entirely, and an alphanumeric id
// lowercased. Both details come from Mercado Pago's documentation and both are
// easy to get wrong silently.
function buildManifest({ dataId, requestId, ts }) {
    let manifest = '';
    if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
    if (requestId) manifest += `request-id:${requestId};`;
    manifest += `ts:${ts};`;
    return manifest;
}

function signatureMatches(manifest, expected, secret) {
    const actual = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    const a = Buffer.from(actual, 'utf8');
    const b = Buffer.from(String(expected), 'utf8');
    // timingSafeEqual throws on a length mismatch, which is itself a mismatch.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Which id Mercado Pago signed over is not the same on every route. The
// documented notification carries data.id in the query string and signs that.
// The one produced by a notification_url on the preference arrives in the older
// shape, ?id=...&topic=payment, and there is no documentation saying whether
// that id is part of the manifest or whether the id part is dropped. So rather
// than assume one shape, try each id the request carries and report which one
// verified, so the caller acts on the id that was actually signed.
//
// A manifest without an id is deliberately not a candidate. Accepting one would
// leave the signature unbound to any payment: a captured ts and v1 could then be
// replayed with somebody else's payment id in the query string, which is exactly
// what this endpoint exists to prevent. If Mercado Pago really does sign without
// the id, this rejects and the log says so, which is the safe way to find out.
// The panel keeps one secret per tab, test and productive, and it is not
// documented which one signs a notification that arrives through the older feed
// rather than through the panel's own registration. Both belong to us, so
// holding both and accepting either costs nothing in strength.
function webhookSecrets() {
    return [process.env.MP_WEBHOOK_SECRET, process.env.MP_WEBHOOK_SECRET_ALT]
        .filter(value => typeof value === 'string' && value.length > 0);
}

function verifySignature({ dataId, queryId, requestId, ts }, expected, secrets) {
    const ids = [];
    if (dataId) ids.push(dataId);
    if (queryId && queryId !== dataId) ids.push(queryId);

    for (const [index, secret] of secrets.entries()) {
        const which = index === 0 ? 'primary' : 'alt';
        for (const id of ids) {
            const manifest = buildManifest({ dataId: id, requestId, ts });
            if (signatureMatches(manifest, expected, secret)) return { ok: true, id, which };
            // Mercado Pago's own docs show request-id taken from the header, but
            // it is absent on some notifications and the manifest then drops the
            // part entirely. Cover the case where the header is present but
            // was not signed over.
            if (requestId) {
                const without = buildManifest({ dataId: id, requestId: null, ts });
                if (signatureMatches(without, expected, secret)) return { ok: true, id, which };
            }
        }
    }
    return { ok: false };
}


// Constant time, so the endpoint does not leak the token one character at a
// time to somebody timing the responses.
function matchesToken(given, expected) {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function firstValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

async function fetchPayment(paymentId, accessToken) {
    const response = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
        console.error('Payment lookup failed:', paymentId, response.status);
        return null;
    }
    return response.json();
}

function statusPatch(status, payment) {
    const patch = {
        status,
        provider_payment_id: String(payment.id),
        amount: payment.transaction_amount ?? null,
        currency: payment.currency_id ?? null,
    };
    if (status === 'paid') {
        const paidAt = payment.date_approved ? new Date(payment.date_approved) : new Date();
        patch.paid_at = paidAt.toISOString();
        patch.expires_at = new Date(paidAt.getTime() + ACCESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
    }
    return patch;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const secrets = webhookSecrets();
    const accessToken = process.env.MP_ACCESS_TOKEN;
    // At least one way of authenticating the caller has to exist, or every
    // notification would be accepted on the strength of nothing.
    if ((!secrets.length && !process.env.MP_NOTIFICATION_TOKEN) || !accessToken) {
        // 500 rather than 200: Mercado Pago retries, so a notification that
        // arrives before the environment is configured is not lost.
        console.error('Webhook not configured:',
            { secrets: secrets.length, token: !!process.env.MP_NOTIFICATION_TOKEN,
              accessToken: !!accessToken });
        return res.status(500).json({ error: 'Not configured' });
    }

    const body = readBody(req) || {};
    const query = req.query || {};

    // Mercado Pago puts the id in the query string; the body carries it too,
    // and older notifications use topic/id instead of type/data.id.
    const candidateId = firstValue(query['data.id']) || body?.data?.id || null;
    const queryId = firstValue(query.id) || null;
    const requestId = req.headers['x-request-id'] || null;

    const signature = parseSignature(req.headers['x-signature']);
    const verified = signature
        ? verifySignature({ dataId: candidateId, queryId, requestId, ts: signature.ts },
            signature.v1, secrets)
        : { ok: false };

    // The token route. Only Mercado Pago has this value, because it only ever
    // leaves here inside a preference's notification_url.
    const token = process.env.MP_NOTIFICATION_TOKEN;
    const tokenOk = Boolean(token) && matchesToken(firstValue(query.k), token);

    if (!verified.ok && !tokenOk) {
        console.error('Webhook rejected:', signature ? 'bad signature' : 'unsigned',
            'for', candidateId || queryId,
            JSON.stringify({ dataId: candidateId, queryId, requestId: !!requestId,
                secrets: secrets.length, token: !!token, k: !!firstValue(query.k) }));
        return res.status(401).json({ error: 'Unauthorised' });
    }

    // Act on the id the signature covered when there was one. On the token
    // route nothing binds the id, which is why the payment is read back from
    // Mercado Pago before any of it is believed.
    const dataId = verified.ok ? verified.id : (candidateId || queryId);

    // Deliberately no freshness window on signature.ts. Mercado Pago retries a
    // failed notification for a long time, and rejecting an old timestamp would
    // drop those retries for good. Replays are harmless here anyway: the
    // payment is re-read from the API every time, and provider_payment_id is
    // unique, so a replay can only re-apply the state that is already true.

    const type = firstValue(query.type) || body?.type || firstValue(query.topic) || body?.topic;
    if (type !== 'payment') {
        return res.status(200).json({ ignored: `type=${type ?? 'none'}` });
    }
    if (!dataId) {
        return res.status(200).json({ ignored: 'no payment id' });
    }

    let payment;
    try {
        payment = await fetchPayment(dataId, accessToken);
    } catch (error) {
        console.error('Payment lookup error:', error.name);
        // Let Mercado Pago retry.
        return res.status(500).json({ error: 'Lookup failed' });
    }
    if (!payment || !payment.id) {
        return res.status(200).json({ ignored: 'payment not found' });
    }

    // A test payment must never unlock the real site, and a real payment must
    // never be consumed by the preview deployment.
    if (Boolean(payment.live_mode) !== expectLiveMode()) {
        console.error('Webhook ignored: live_mode mismatch for', payment.id, payment.live_mode);
        return res.status(200).json({ ignored: 'live_mode mismatch' });
    }

    const status = STATUS_MAP[payment.status];
    if (!status) {
        // pending, in_process, authorized: the final state will arrive later.
        return res.status(200).json({ ignored: `status=${payment.status}` });
    }

    const paymentId = String(payment.id);

    // Already recorded? provider_payment_id is unique, so this is the
    // idempotency check; the constraint is the backstop behind it.
    const existing = await sbSelect(
        `purchases?select=id,status&provider_payment_id=eq.${encodeURIComponent(paymentId)}&limit=1`);
    if (existing.rows.length) {
        if (existing.rows[0].status === status) {
            return res.status(200).json({ ok: true, already: status });
        }
        const changed = await sbPatch(
            `purchases?id=eq.${encodeURIComponent(existing.rows[0].id)}`,
            statusPatch(status, payment));
        return res.status(changed.ok ? 200 : 500).json({ ok: changed.ok, status });
    }

    const userId = payment.external_reference;
    if (!userId || !UUID_RE.test(userId)) {
        console.error('Webhook ignored: no usable external_reference on', paymentId);
        return res.status(200).json({ ignored: 'no account on payment' });
    }

    // The pending row this checkout created. Matched on the account rather than
    // the preference, because the payment object does not carry the preference
    // id.
    const pending = await sbSelect(
        `purchases?select=id`
        + `&user_id=eq.${encodeURIComponent(userId)}`
        + `&status=eq.pending`
        + `&live_mode=eq.${expectLiveMode()}`
        + `&order=created_at.desc&limit=1`);

    if (pending.rows.length) {
        const changed = await sbPatch(
            `purchases?id=eq.${encodeURIComponent(pending.rows[0].id)}`,
            statusPatch(status, payment));
        if (!changed.ok) return res.status(500).json({ error: 'Could not record payment' });
        return res.status(200).json({ ok: true, status });
    }

    // No pending row: the insert at checkout time failed, or the payment was
    // started some other way. The payment itself carries everything needed.
    const created = await sbInsert('purchases', {
        user_id: userId,
        email: payment.payer?.email || null,
        provider: 'mercadopago',
        live_mode: expectLiveMode(),
        ...statusPatch(status, payment),
    });
    if (!created.ok) {
        // A unique violation here means a concurrent notification won the race,
        // which is a success, not a failure.
        if (created.status === 409) return res.status(200).json({ ok: true, already: status });
        return res.status(500).json({ error: 'Could not record payment' });
    }
    return res.status(200).json({ ok: true, status });
}
