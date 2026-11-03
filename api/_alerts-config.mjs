// Vercel serverless function: /api/alerts-config
//
// Answers one question: may this visitor be offered the alert subscription,
// and with what. Called once, lazily, the first time somebody runs a check,
// so a visitor who never searches never costs an invocation.
//
// The country decides, and the country never travels back. The response says
// eligible true or false and nothing else about location. Telling a browser
// "we think you are in Peru" is a fact about the visitor we have no reason to
// hand them, and it would be the one piece of this that a screenshot could
// turn into a complaint.
//
// Eligibility is United States only, which is the whole design: the alerts
// are about United States class action settlements, the subscription is
// priced in dollars through Paddle, and the privacy notice that covers it is
// written for United States law. Offering it anywhere else would be selling
// something that cannot pay out.

import { isUnitedStates, paddleConfig } from './_shared.js';

export async function handleConfig(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Per visitor, so one person's country is never served to another from a
    // shared cache. Vercel caches /api/* for zero seconds already, and this
    // says so explicitly rather than relying on that staying true.
    res.setHeader('Cache-Control', 'private, no-store');

    if (!isUnitedStates(req)) {
        return res.status(200).json({ eligible: false });
    }

    // Eligible by country but not configured yet. Answered as not eligible
    // rather than as an error: a visitor should see no card at all, not a
    // card that fails when they click it.
    const paddle = paddleConfig('PADDLE_PRICE_ID');
    if (!paddle) {
        console.error('Alerts not configured');
        return res.status(200).json({ eligible: false });
    }

    // The $5 one-time "see the list" is its own Paddle product. It is optional:
    // when the owner has not set the price up yet, the funnel shows an
    // availability note on that button instead of a checkout that cannot charge.
    // Everything else (the free number, the monthly monitoring) is unaffected.
    const out = { eligible: true, ...paddle };
    const listUnlock = process.env.PADDLE_PRICE_LIST_UNLOCK;
    if (listUnlock) out.listUnlockPriceId = listUnlock;

    return res.status(200).json(out);
}
