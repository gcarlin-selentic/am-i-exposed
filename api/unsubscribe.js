// Vercel serverless function: /api/unsubscribe
// The link in every breach-monitoring mail lands here with the subscriber's
// unsubscribe token. A matching row becomes 'unsubscribed' and a localized
// confirmation page is shown. Visiting again just re-sets the same status, so
// the link is idempotent. A bad token gets the same generic page as a missing
// row, so the endpoint reveals nothing about which tokens or addresses exist.
//
// Neither the token nor any address is logged.

import { rateLimitOk, sbSelect, sbPatch, clientIp, makeLocalLimiter } from './_shared.js';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

const localLimiter = makeLocalLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS * 1000);

const PAGES = {
    done: {
        es: {
            title: 'Te diste de baja',
            text: 'Listo, dejamos de monitorear tu correo. No volverás a recibir avisos de filtraciones. Si cambias de opinión, puedes volver a suscribirte desde la página.',
            en: 'Done. You are unsubscribed and will not get any more breach alerts.',
        },
        en: {
            title: 'You are unsubscribed',
            text: 'Done, we stopped monitoring your email. You will not get any more breach alerts. If you change your mind, you can sign up again from the site.',
            en: 'Listo. Te diste de baja y no recibirás más avisos.',
        },
    },
    invalid: {
        es: {
            title: 'Enlace no válido',
            text: 'Este enlace no es válido. Si sigues recibiendo avisos que no quieres, responde a cualquiera de nuestros correos y te damos de baja.',
            en: 'This link is not valid. If you still get alerts you do not want, reply to any of our emails and we will remove you.',
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
    const shared = await rateLimitOk(`unsub:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
    const overLimit = shared === null ? localLimiter(ip) : !shared;

    if (overLimit) {
        res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_SECONDS));
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const token = req.query?.token;
    if (typeof token !== 'string' || token.length === 0) {
        return sendPage(res, PAGES.invalid.es);
    }

    try {
        const sel = await sbSelect(
            `breach_watch?unsubscribe_token=eq.${encodeURIComponent(token)}&select=id,lang`
        );
        if (!sel.ok) {
            return res.status(500).json({ error: 'Service unavailable' });
        }

        const row = sel.rows?.[0];
        if (!row) {
            return sendPage(res, PAGES.invalid.es);
        }

        const saved = await sbPatch(`breach_watch?id=eq.${row.id}`, { status: 'unsubscribed' });
        if (!saved.ok) {
            return res.status(500).json({ error: 'Service unavailable' });
        }

        const lang = row.lang === 'en' ? 'en' : 'es';
        return sendPage(res, PAGES.done[lang], lang);
    } catch (error) {
        // Name only: the token must not reach a log.
        console.error('unsubscribe error:', error.name);
        return res.status(500).json({ error: 'Service unavailable' });
    }
}
