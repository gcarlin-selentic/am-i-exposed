// Vercel serverless function: /api/confirm-subscription
// Second step of the double opt-in. The link in the confirmation mail lands
// here with a one-time token; a matching pending row becomes active and the
// token is cleared. A bad, expired or already-used token gets the same generic
// page, so the endpoint reveals nothing about which tokens or addresses exist.
//
// Neither the token nor any address is logged.

import { rateLimitOk, sbSelect, sbPatch, clientIp, makeLocalLimiter } from './_shared.js';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const localLimiter = makeLocalLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS * 1000);

const PAGES = {
    confirmed: {
        es: {
            title: 'Monitoreo activado',
            text: 'Listo, confirmamos tu correo. Te avisaremos si aparece en una nueva filtración de datos.',
            en: 'Done. Your breach monitoring is now active.',
        },
        en: {
            title: 'Monitoring active',
            text: 'Done, your email is confirmed. We will let you know if it shows up in a new data breach.',
            en: 'Listo. Tu monitoreo de brechas está activo.',
        },
    },
    invalid: {
        es: {
            title: 'Enlace no válido',
            text: 'Este enlace no es válido o ya se usó. Si quieres activar el monitoreo, vuelve a suscribirte desde la página y te enviaremos un enlace nuevo.',
            en: 'This link is invalid or already used. Sign up again from the site to get a new one.',
        },
    },
};

function pageHtml({ title, text, en }, lang) {
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<meta name="robots" content="noindex">`
        + `<title>${title} · Am I Exposed</title></head>`
        + `<body style="margin:0;background:#FAFAFA;">`
        + `<div style="max-width:560px;margin:0 auto;padding:32px 20px;`
        + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;`
        + `font-size:15px;line-height:1.6;color:#111;">`
        + `<p style="margin:0 0 20px;font-weight:700;font-size:17px;">Am I Exposed</p>`
        + `<h1 style="margin:0 0 16px;font-size:21px;">${title}</h1>`
        + `<p style="margin:0 0 14px;">${text}</p>`
        + `<p style="margin:0 0 14px;font-size:13px;color:#666;">${en}</p>`
        + `<p style="margin:24px 0 0;font-size:14px;"><a href="/" style="color:#111;">am-i-exposed.com</a></p>`
        + `</div></body></html>`;
}

function sendPage(res, page, lang = 'es') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(pageHtml(page, lang));
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = clientIp(req);
    const shared = await rateLimitOk(`confirm:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
    const overLimit = shared === null ? localLimiter(ip) : !shared;

    if (overLimit) {
        res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_SECONDS));
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const token = req.query?.token;
    // The column is a uuid: a non-uuid value would make PostgREST answer 400.
    if (typeof token !== 'string' || !UUID_RE.test(token)) {
        return sendPage(res, PAGES.invalid.es);
    }

    try {
        const sel = await sbSelect(
            `breach_watch?confirm_token=eq.${encodeURIComponent(token)}&status=eq.pending&select=id,lang`
        );
        if (!sel.ok) {
            return res.status(500).json({ error: 'Service unavailable' });
        }

        const row = sel.rows?.[0];
        if (!row) {
            return sendPage(res, PAGES.invalid.es);
        }

        const saved = await sbPatch(`breach_watch?id=eq.${row.id}&status=eq.pending`, {
            status: 'active',
            confirmed_at: new Date().toISOString(),
            confirm_token: null,
        });
        if (!saved.ok) {
            return res.status(500).json({ error: 'Service unavailable' });
        }

        const lang = row.lang === 'en' ? 'en' : 'es';
        return sendPage(res, PAGES.confirmed[lang], lang);
    } catch (error) {
        // Name only: the token must not reach a log.
        console.error('confirm-subscription error:', error.name);
        return res.status(500).json({ error: 'Service unavailable' });
    }
}
