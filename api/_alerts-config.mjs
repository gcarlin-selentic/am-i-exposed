// Vercel function (routed by monitor.js as op=config): /api/alerts-config
//
// Tells the page which paid offers to show, so a button appears only when its
// Stripe price is configured. No geo-block: Stripe is the merchant of record for
// everyone and the prices are USD. A plan whose price env is unset is simply not
// offered, which is how settlement/combo stay hidden until their price ids are
// set (e.g. while their backend is still being finished).

import { priceIdFor } from './_stripe.mjs';

export async function handleConfig(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Per visitor; /api/* is already uncached, and this says so explicitly.
    res.setHeader('Cache-Control', 'private, no-store');

    const configured = !!process.env.STRIPE_SECRET_KEY;
    const has = (plan) => configured && !!priceIdFor(plan);

    const plans = {
        report: has('report'),
        breach: has('breach_month') || has('breach_year'),
        settlement: has('settlement_month') || has('settlement_year'),
        combo: has('combo_month') || has('combo_year'),
    };
    const eligible = Object.values(plans).some(Boolean);

    return res.status(200).json({ eligible, plans });
}
