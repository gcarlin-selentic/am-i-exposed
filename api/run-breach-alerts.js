// Vercel serverless function: /api/run-breach-alerts
// The daily breach-monitoring pass. An authenticated POST (the "Radar" routine
// calls it) reads every active subscriber, asks HIBP about each address, and
// hands the results to processSubscribers, which decides welcome / alert / none,
// sends the mail and updates the rows. The branching logic lives in
// _breach-watch.mjs and is unit-tested; this file is the I/O around it.
//
// Fails closed, like healthcheck.js: no CRON_SECRET means the job is off (503),
// a wrong or missing bearer token is 401. Each run spends the shared HIBP quota
// and can send mail, so it must never answer an unauthenticated caller.
//
// Only rows with status=active are read. Under double opt-in that already
// excludes pending (never confirmed) and unsubscribed addresses.
//
// `?dryrun=1` runs the real HIBP lookups but sends no mail and writes nothing,
// so a preview deploy can be checked without touching subscribers.
//
// The response carries counts only, never an address. Nothing here logs an
// address or an unsubscribe token.

import { authorizeCron, processSubscribers } from './_breach-watch.mjs';
import { sbSelect, sbPatch, publicBaseUrl } from './_shared.js';
import { sendBreachWelcome, sendBreachAlert } from './_email.js';

const HIBP_ENDPOINT = 'https://haveibeenpwned.com/api/v3/breachedaccount';
const HIBP_PACE_MS = 6500;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const config = { maxDuration: 60 };

// Must never throw: processSubscribers has no try/catch around the lookup, so a
// throw would abort the whole batch. Every failure maps to status 'error', which
// leaves the row untouched and retries tomorrow.
//
// Pacing: each lookup waits HIBP_PACE_MS first, keeping calls under HIBP's
// 10 requests per minute. At ~6.5s per subscriber under the 60s maxDuration cap
// below, a single run handles roughly 8 subscribers. Beyond that, process a
// slice per run (batching) or raise the HIBP plan. A persistently high `errors`
// count in the response means the list has outgrown one run.
async function hibpLookup(email) {
    try {
        await sleep(HIBP_PACE_MS);
        const response = await fetch(
            `${HIBP_ENDPOINT}/${encodeURIComponent(email)}?truncateResponse=false`,
            {
                method: 'GET',
                headers: {
                    'User-Agent': 'Am-I-Exposed-Watch',
                    'hibp-api-key': process.env.HIBP_API_KEY || '',
                },
                signal: AbortSignal.timeout(8000),
            }
        );

        if (response.status === 404) return { status: 'clean', names: [] };

        if (response.status === 200) {
            const body = await response.json().catch(() => []);
            // A malformed 200 is an error, not "found with no names": on a
            // baseline run it would store an empty known_breaches list.
            if (!Array.isArray(body)) return { status: 'error', names: [] };
            const names = body.map(b => b && b.Name).filter(n => typeof n === 'string');
            return { status: 'found', names };
        }

        // 429, 401, 5xx and anything unexpected.
        return { status: 'error', names: [] };
    } catch {
        return { status: 'error', names: [] };
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return res.status(503).json({ error: 'Monitoring not configured' });
    }
    if (!authorizeCron(req.headers.authorization || '', secret)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const dry = req.query?.dryrun === '1' || (req.url || '').includes('dryrun=1');

    try {
        const sel = await sbSelect(
            'breach_watch?status=eq.active&select=id,email,known_breaches,baseline_done,lang,unsubscribe_token'
        );
        // A failed read is not an empty list: say so, so the routine sees red
        // instead of a quiet "checked: 0".
        if (!sel.ok) {
            return res.status(500).json({ error: 'Service unavailable' });
        }
        const subscribers = sel.rows || [];

        const base = publicBaseUrl(req) || 'https://www.am-i-exposed.com';
        const unsub = sub => `${base}/api/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;

        const deps = dry
            ? {
                sendWelcome: async () => true,
                sendAlert: async () => true,
                patch: async () => true,
            }
            : {
                sendWelcome: (sub, breaches) => sendBreachWelcome({
                    to: sub.email,
                    lang: sub.lang,
                    breaches,
                    siteUrl: base,
                    unsubscribeUrl: unsub(sub),
                }),
                sendAlert: (sub, names) => sendBreachAlert({
                    to: sub.email,
                    lang: sub.lang,
                    newBreaches: names,
                    siteUrl: base,
                    unsubscribeUrl: unsub(sub),
                }),
                patch: (id, fields) => sbPatch(`breach_watch?id=eq.${id}`, fields).then(r => r.ok),
            };

        const counts = await processSubscribers({
            subscribers,
            hibpLookup,
            ...deps,
            now: () => new Date().toISOString(),
        });

        return res.status(200).json({ ok: true, dry, ...counts, at: new Date().toISOString() });
    } catch (error) {
        // Name only: a thrown error can carry a request with an address in it.
        console.error('run-breach-alerts error:', error.name);
        return res.status(500).json({ error: 'Service unavailable' });
    }
}
