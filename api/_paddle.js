// Paddle webhook handling, shared by the live and sandbox endpoints.
//
// Vercel does not route a file in /api whose name starts with an underscore,
// so this is a module, not an endpoint.
//
// There are two endpoints rather than one that tells the environments apart by
// which secret verified it. One endpoint would be less code and the wrong
// trade: the whole job of this file is deciding who is subscribed, and a
// configuration slip that let a sandbox event through on the live path would
// hand out real alerts for a test card. Two endpoints, two secrets, two
// Paddle destinations, and live_mode decided by which file was called, not by
// anything in the payload.

import crypto from 'node:crypto';

import { sendReceipt } from './_email.js';
import { syncPurchase } from './_zoho.js';
import { publicBaseUrl, sbInsert, sbPatch, sbSelect } from './_shared.js';

// Paddle's own status values, passed through untranslated. The table's check
// constraint lists the same five.
const KNOWN_STATUS = new Set(['trialing', 'active', 'past_due', 'paused', 'canceled']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Enough for a subscription event several times over. A body larger than this
// is not something Paddle sent, and reading it to the end would be the whole
// attack: an endpoint that buffers whatever it is given.
const MAX_BODY_BYTES = 256 * 1024;

// The signature covers the bytes exactly as they arrived, so the body has to
// be read raw. JSON.stringify(req.body) looks equivalent and is not: it
// reformats, and Paddle's documentation is explicit that any transformation of
// the raw body produces a different signed payload and the signatures stop
// matching. The handlers set bodyParser: false so this stream is still intact.
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

// Paddle-Signature looks like: ts=1671552777;h1=eb4d0dc8...
//
// More than one h1 can appear: Paddle documents that during a secret rotation
// several are sent at once, so any of them matching is a match.
export function parseSignature(header) {
    if (typeof header !== 'string') return null;

    let ts = null;
    const hashes = [];
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === 'ts') ts = value;
        else if (key === 'h1') hashes.push(value);
    }
    return ts && hashes.length ? { ts, hashes } : null;
}

function matches(expected, actual) {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(actual, 'utf8');
    // timingSafeEqual throws on a length mismatch, which is itself a mismatch.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// HMAC-SHA256 over "<ts>:<raw body>", keyed by the destination's secret.
export function signatureValid(rawBody, signature, secret) {
    const payload = Buffer.concat([
        Buffer.from(`${signature.ts}:`, 'utf8'),
        rawBody,
    ]);
    const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return signature.hashes.some(h1 => matches(digest, h1));
}

// Deliberately no freshness window on ts.
//
// Paddle's own SDKs default to rejecting anything older than five seconds.
// That is right for a server that is always up and wrong here: Vercel cold
// starts and Paddle's own retries both produce events that arrive late, and
// rejecting them would drop a cancellation for good. Replay is handled where
// it actually matters instead, by occurred_at below: an old event cannot undo
// a newer one no matter how many times it is sent.

function periodEnd(data) {
    const ends = data?.current_billing_period?.ends_at;
    return typeof ends === 'string' ? ends : null;
}

// What the browser sent in customData when it opened the checkout. Paddle
// echoes it back on every event for that subscription.
//
// user_id is the one field that must be right, because it decides whose
// account gets the alerts. It is checked against the UUID shape rather than
// trusted: custom_data is whatever the checkout put there, and a malformed
// value would otherwise reach Postgres as a foreign key and fail noisily at
// the worst moment.
function fromCustomData(data) {
    const custom = data?.custom_data;
    if (!custom || typeof custom !== 'object') return {};

    const userId = typeof custom.user_id === 'string' && UUID_RE.test(custom.user_id)
        ? custom.user_id
        : null;

    const text = value => (typeof value === 'string' && value.trim()
        ? value.trim().slice(0, 120)
        : null);

    return {
        userId,
        // Which of the two things was bought. Set by the checkout, and the
        // only thing separating a report transaction from the first payment
        // of an alerts subscription.
        kind: custom.kind === 'report' || custom.kind === 'alerts'
            ? custom.kind : null,
        email: text(custom.email),
        // Which language to write the receipt in. The page knows; the
        // transaction would not otherwise carry it.
        lang: custom.lang === 'en' ? 'en' : 'es',
        firstName: text(custom.first_name),
        lastName: text(custom.last_name),
        state: text(custom.state),
    };
}

// One purchase buys thirty days of report access, the same as a Mercado Pago
// purchase does. The two providers write into the same purchases table and
// the entitlement check does not care which paid.
const ACCESS_DAYS = 30;

// A completed transaction, which is the report bought once rather than the
// alerts billed monthly.
//
// Paddle also raises transaction.completed for the first payment of a
// subscription, and that one must not land here: it would grant report
// access to somebody who bought alerts. Two things keep them apart, and both
// are required rather than either, because this is the function that hands
// out paid access:
//
//   - custom_data.kind, which the checkout sets explicitly
//   - subscription_id, which Paddle sets on anything recurring
async function applyTransaction(event, liveMode, req) {
    const data = event?.data;
    const transactionId = data?.id;
    if (!transactionId) return { handled: false, reason: 'no transaction id' };

    if (data.subscription_id) {
        return { handled: false, reason: 'belongs to a subscription' };
    }

    const custom = fromCustomData(data);
    if (custom.kind !== 'report') {
        return { handled: false, reason: `kind=${custom.kind ?? 'none'}` };
    }
    if (!custom.userId) {
        console.error('Paddle transaction with no account:', transactionId);
        return { handled: false, reason: 'no account on transaction' };
    }

    // Already recorded? provider_payment_id is unique, so this is the
    // idempotency check and the constraint is the backstop behind it.
    const existing = await sbSelect(
        'purchases?select=id,status'
        + `&provider_payment_id=eq.${encodeURIComponent(transactionId)}&limit=1`);
    if (existing.rows.length) {
        return { handled: true, reason: 'already recorded' };
    }

    // The amount Paddle actually charged, in the lowest denomination, which
    // is what every Paddle total is. Read back from the event rather than
    // from anything the page said: the page can be edited, the event is
    // signed.
    const totals = data.details?.totals || {};
    const cents = Number(totals.grand_total ?? totals.total);
    const paidAt = data.billed_at || event.occurred_at || new Date().toISOString();
    const expires = new Date(new Date(paidAt).getTime()
        + ACCESS_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const created = await sbInsert('purchases', {
        user_id: custom.userId,
        email: custom.email || null,
        provider: 'paddle',
        live_mode: liveMode,
        provider_payment_id: transactionId,
        status: 'paid',
        amount: Number.isFinite(cents) ? cents / 100 : null,
        currency: data.currency_code || null,
        paid_at: paidAt,
        expires_at: expires,
    });

    if (!created.ok) {
        // A concurrent delivery of the same event won the race, which is a
        // success rather than a failure, and the winner already sent the
        // mail. Returning here is also what stops a retry thanking somebody
        // twice for one purchase.
        if (created.status === 409) return { handled: true, reason: 'conflict' };
        return { handled: false, reason: 'insert failed', retry: true };
    }

    // Paddle sends its own receipt as merchant of record. This is the other
    // one: ours, with the link that opens the plan they just paid for.
    //
    // Awaited but never allowed to matter, exactly as the Mercado Pago
    // webhook does it. If Brevo is down the money is still recorded and the
    // access is still granted, and failing here would only make Paddle retry
    // an event that was handled correctly.
    if (custom.email) {
        try {
            await sendReceipt({
                to: custom.email,
                lang: custom.lang,
                amount: Number.isFinite(cents) ? cents / 100 : null,
                currency: data.currency_code,
                paidAt,
                expiresAt: expires,
                siteUrl: publicBaseUrl(req),
            });
            await syncPurchase({
                email: custom.email,
                lang: custom.lang,
                amount: Number.isFinite(cents) ? cents / 100 : null,
                currency: data.currency_code,
                paidAt,
            });
        } catch (error) {
            console.error('Buyer notification failed:', error.name);
        }
    }

    return { handled: true, status: 'paid', created: true };
}

async function applyEvent(event, liveMode) {
    const data = event?.data;
    const subscriptionId = data?.id;
    const status = data?.status;

    if (!subscriptionId || !KNOWN_STATUS.has(status)) {
        return { handled: false, reason: `status=${status ?? 'none'}` };
    }

    const occurredAt = event.occurred_at || new Date().toISOString();
    const custom = fromCustomData(data);

    const patch = {
        status,
        provider_customer_id: data.customer_id || null,
        current_period_end: periodEnd(data),
        canceled_at: data.canceled_at || null,
        last_event_at: occurredAt,
    };
    // Only overwrite the details when this event actually carries them, so an
    // event with no custom_data cannot blank out a name collected at checkout.
    if (custom.email) patch.email = custom.email;
    if (custom.firstName) patch.first_name = custom.firstName;
    if (custom.lastName) patch.last_name = custom.lastName;
    if (custom.state) patch.state = custom.state;

    const existing = await sbSelect(
        'alert_subscriptions?select=id,last_event_at'
        + `&provider_subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`);

    if (existing.rows.length) {
        const row = existing.rows[0];

        // The replay and out-of-order guard. Paddle does not promise delivery
        // order, so subscription.canceled can land before an older
        // subscription.updated that still says active. Filtering on
        // last_event_at in the request itself, rather than comparing in
        // JavaScript and then patching, means two events racing each other
        // cannot both decide they are the newer one.
        const filter = row.last_event_at
            ? `&last_event_at=lt.${encodeURIComponent(occurredAt)}`
            : '&last_event_at=is.null';

        const changed = await sbPatch(
            `alert_subscriptions?id=eq.${encodeURIComponent(row.id)}${filter}`, patch);

        if (!changed.ok) return { handled: false, reason: 'update failed', retry: true };
        if (!changed.rows.length) return { handled: true, reason: 'stale event ignored' };
        return { handled: true, status };
    }

    // No row yet. Every subscription should arrive as subscription.created
    // first, but the first event we see is whichever one Paddle delivered
    // first, so any of them has to be able to create the row.
    if (!custom.userId || !custom.email) {
        // Without an account this cannot be attached to anybody. Answered 200
        // so Paddle stops retrying something no retry will fix, and logged
        // loudly because it means the checkout did not send customData.
        console.error('Paddle event with no account:', subscriptionId,
            JSON.stringify({ user_id: !!custom.userId, email: !!custom.email }));
        return { handled: false, reason: 'no account on subscription' };
    }

    const created = await sbInsert('alert_subscriptions', {
        user_id: custom.userId,
        email: custom.email,
        provider: 'paddle',
        provider_subscription_id: subscriptionId,
        live_mode: liveMode,
        first_name: custom.firstName,
        last_name: custom.lastName,
        state: custom.state,
        ...patch,
    });

    if (created.ok) return { handled: true, status, created: true };

    // 409 is the unique index doing its job, and it means one of two things.
    // Either two events for this subscription raced and the other won, which
    // is a success. Or this email already has a live subscription, which is
    // the "one per email" rule refusing a second one. Both end here: Paddle
    // should not retry, and in the second case somebody is owed a refund that
    // only a human should decide on.
    if (created.status === 409) {
        console.error('Paddle subscription conflicted:', subscriptionId, custom.email);
        return { handled: true, reason: 'conflict' };
    }
    return { handled: false, reason: 'insert failed', retry: true };
}

// Builds a handler for one environment. The caller passes the environment
// variable holding that destination's secret, and whether rows it writes are
// live. Nothing in the payload decides either.
export function paddleWebhookHandler({ secretEnv, liveMode }) {
    return async function handler(req, res) {
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ error: 'Method not allowed' });
        }

        const secret = process.env[secretEnv];
        if (!secret) {
            // 500 rather than 200: Paddle retries, so an event that arrives
            // before the environment is configured is not lost.
            console.error('Paddle webhook not configured:', secretEnv);
            return res.status(500).json({ error: 'Not configured' });
        }

        let rawBody;
        try {
            rawBody = await readRawBody(req);
        } catch (error) {
            console.error('Paddle body read failed:', error.message);
            return res.status(400).json({ error: 'Bad request' });
        }

        const signature = parseSignature(req.headers['paddle-signature']);
        if (!signature || !signatureValid(rawBody, signature, secret)) {
            console.error('Paddle webhook rejected:',
                signature ? 'bad signature' : 'unsigned', secretEnv);
            return res.status(401).json({ error: 'Unauthorised' });
        }

        let event;
        try {
            event = JSON.parse(rawBody.toString('utf8'));
        } catch (error) {
            return res.status(400).json({ error: 'Bad JSON' });
        }

        const type = event?.event_type;

        let result;
        if (typeof type === 'string' && type.startsWith('subscription.')) {
            result = await applyEvent(event, liveMode);
        } else if (type === 'transaction.completed') {
            result = await applyTransaction(event, liveMode, req);
        } else {
            // Products, adjustments, anything else: not subscribed to, and
            // answered 200 so Paddle does not retry something we chose to
            // ignore.
            return res.status(200).json({ ignored: `event_type=${type ?? 'none'}` });
        }

        // Only a database failure asks for a retry. Everything else is a
        // decision we made and repeating it would not change the outcome.
        if (result.retry) return res.status(500).json({ error: result.reason });
        return res.status(200).json({ ok: true, ...result });
    };
}
