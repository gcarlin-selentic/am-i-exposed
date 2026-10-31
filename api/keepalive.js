// Keeps the Supabase project from auto-pausing on the free tier.
//
// Supabase pauses a project after seven days without database activity. The
// site's own traffic was not enough to count: the free email check talks to
// HIBP, not the database, and the only calls that reach Postgres (rate limit,
// stats, entitlement, account) sit on paid or logged-in paths that can stay
// quiet for days. A paused database breaks the paid report, because entitlement
// is read from Postgres and fails closed, so a quiet week took the paying flow
// offline without anyone touching the site.
//
// A Vercel cron hits this once a day. All it has to do is make one real request
// to the database, which resets the inactivity clock. It reuses the rate-limit
// RPC on purpose: that runs a Postgres function, so the request reaches the
// database itself rather than stopping at the API edge.
//
// The endpoint is harmless (nothing read in, a single bounded counter touched,
// nothing about anyone returned), but it is still gated: when CRON_SECRET is
// set, only a caller carrying it as a bearer token gets through, which is the
// header Vercel Cron sends when that variable exists. With CRON_SECRET unset it
// stays open, so the keep-alive works the moment it deploys and can be hardened
// later by adding the variable.

import { rateLimitOk } from './_shared.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');

    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // One real database call. The result does not matter; reaching Postgres is
    // the whole point. rateLimitOk returns null instead of throwing when the
    // database cannot answer, so a blip here is reported, not a crash. Even a
    // request that times out still left for Supabase, which is what the clock
    // counts.
    const reached = await rateLimitOk('keepalive', 1000000, 86400);

    return res.status(200).json({
        ok: true,
        database: reached === null ? 'unreachable' : 'reached',
        at: new Date().toISOString(),
    });
}
