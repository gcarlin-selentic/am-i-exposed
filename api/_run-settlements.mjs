// Vercel function (routed by monitor.js as op=run-settlements): /api/run-settlement-alerts
//
// The daily settlement-monitoring pass. An authenticated POST (the Radar routine
// calls it) reads every active settlement/combo subscriber and emails each a
// digest of the open settlements they may be able to claim and have not been
// alerted about yet. Fails closed like the breach run: no CRON_SECRET is 503, a
// wrong/missing bearer is 401.
//
// Subscribers are confirmed (status=active) AND paying (sub_status=active) for a
// settlement/combo plan, in this environment (live_mode). Dedup is per
// (email, settlement) via settlement_alerts_sent, so a case alerts once.
//
// `?dryrun=1` selects and counts but sends no mail and writes nothing.
//
// Reads the scraper's open set from the deployed bundle (data/open-settlements.json),
// so new-case timeliness is bound by the weekly scraper, by design. The response
// carries counts only, never an address.

import OPEN from '../data/open-settlements.json' with { type: 'json' };
import { authorizeCron } from './_breach-watch.mjs';
import { sbSelect, sbInsert, liveModeFor, publicBaseUrl } from './_shared.js';
import { sendSettlementAlert } from './_email.js';
import { selectForSubscriber, buildAlertEmail } from './_settlement-alerts.mjs';

export async function handleRunSettlements(req, res) {
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

    // A scraper failure that empties the open set must not look like "no money":
    // send nothing rather than alerting an empty digest.
    if (!Array.isArray(OPEN) || OPEN.length < 1) {
        return res.status(200).json({ ok: true, skipped: 'empty open set', checked: 0, alerted: 0, errors: 0 });
    }

    const liveMode = liveModeFor('stripe');
    const today = new Date().toISOString().slice(0, 10);
    const base = publicBaseUrl(req) || 'https://www.am-i-exposed.com';

    const sel = await sbSelect(
        `breach_watch?status=eq.active&sub_status=eq.active&plan=in.(settlement,combo)&live_mode=eq.${liveMode}` +
        '&select=id,email,lang,unsubscribe_token'
    );
    // A failed read is not an empty list: answer 500 so the routine sees red.
    if (!sel.ok) {
        return res.status(500).json({ error: 'Service unavailable' });
    }
    const subs = sel.rows || [];

    let checked = 0, alerted = 0, errors = 0;
    for (const s of subs) {
        checked++;
        try {
            const already = await sbSelect(
                `settlement_alerts_sent?email=eq.${encodeURIComponent(s.email)}&live_mode=eq.${liveMode}&select=settlement_id`
            );
            if (!already.ok) { errors++; continue; }

            const { welcome, items } = selectForSubscriber(
                OPEN, (already.rows || []).map(r => r.settlement_id), today
            );
            if (!items.length) continue;
            if (dry) { alerted++; continue; }

            const unsubscribeUrl = `${base}/api/unsubscribe?token=${encodeURIComponent(s.unsubscribe_token)}`;
            const { subject, html } = buildAlertEmail({ items, welcome, lang: s.lang, unsubscribeUrl });

            const ok = await sendSettlementAlert({ to: s.email, subject, html });
            if (!ok) { errors++; continue; }

            // Record only after a successful send. A later insert failure risks a
            // re-send next run (a duplicate), never a dropped alert.
            const ins = await sbInsert('settlement_alerts_sent', items.map(it => ({
                email: s.email, settlement_id: it.id, live_mode: liveMode,
            })));
            if (!ins.ok) { errors++; continue; }
            alerted++;
        } catch (error) {
            // Name only: an address must not reach a log.
            console.error('run-settlements subscriber failed:', error.name);
            errors++;
        }
    }

    return res.status(200).json({ ok: true, dry, checked, alerted, errors, at: new Date().toISOString() });
}
