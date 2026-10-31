// A daily self-check for the two silent failures this site has already had: the
// paid flow going dark when Supabase pauses, and the free email check returning
// "Service not configured" when the HIBP key lapses. Neither announced itself;
// a visitor saw a red box days before anyone looked. A Vercel cron hits this
// once a day and it emails only when something is actually wrong, so a quiet
// inbox means a working site.
//
// It probes the deployed endpoints over HTTP rather than calling their code in
// process, on purpose: that exercises the real routing, headers and runtime a
// visitor hits, which is where this kind of failure lives.
//
//   - /api/keepalive returns database:"reached" only when the request got all
//     the way to Postgres, so it doubles as the Supabase health signal.
//   - /api/check-email with a throwaway address should answer 200 (found or
//     not). The 500 "Service not configured" is the HIBP-key failure, named in
//     the alert so it says which key to renew.
//
// Only a failure sends mail. The trade is that a cron which stops firing sends
// nothing: this catches a broken site, not a broken cron. A dead-man's switch
// (an external pinger expecting a daily beacon) is the next step if that ever
// matters.
//
// Fails closed. Unlike the keep-alive, every run of this endpoint spends the
// shared HIBP quota (the check-email probe), can send mail, and names which
// internal service is down, so it must never answer an unauthenticated caller:
// an open one would let anyone burn the quota, fan out alert mail, and read the
// site's health. It requires CRON_SECRET as a bearer token, compared in
// constant time. Vercel Cron attaches that header automatically once CRON_SECRET
// is set on the project; until it is set the monitor stays off rather than open,
// and the checks do not run at all. The recipient is ALERT_EMAIL; with that
// unset the check runs but cannot mail, and says so in its response.

import { sendOpsAlert } from './_email.js';

const SITE = 'https://www.am-i-exposed.com';

// Constant-time compare, so the secret cannot be recovered a character at a time
// from how long a mismatch takes to answer. Same shape as supabase-hook.js.
function secretMatches(given, expected) {
    if (!expected || !given) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

async function checkKeepalive() {
    try {
        const r = await fetch(`${SITE}/api/keepalive`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) {
            return { name: 'supabase', ok: false, detail: `HTTP ${r.status} en /api/keepalive` };
        }
        const data = await r.json().catch(() => ({}));
        if (data.database !== 'reached') {
            return {
                name: 'supabase',
                ok: false,
                detail: 'La base no respondió (pausada o inalcanzable). Revisa el proyecto en Supabase.',
            };
        }
        return { name: 'supabase', ok: true };
    } catch (e) {
        return { name: 'supabase', ok: false, detail: `/api/keepalive no respondió: ${e.name}` };
    }
}

async function checkEmailCheck() {
    // A throwaway address that never matches; the point is the service
    // answering, not the result. Origin is omitted so the endpoint's
    // same-origin guard passes without depending on how the host header arrives.
    try {
        const r = await fetch(`${SITE}/api/check-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'healthcheck@am-i-exposed.com', lang: 'es', origen: 'healthcheck' }),
            signal: AbortSignal.timeout(12000),
        });
        if (r.status === 200) return { name: 'check-email', ok: true };
        // The daily probe never comes close to the rate limit, but if it ever
        // does, that is throttling working, not the service down.
        if (r.status === 429) return { name: 'check-email', ok: true, detail: 'rate limited (no es falla)' };

        let body = '';
        try { body = (await r.text()).slice(0, 200); } catch { /* ignore */ }

        const isHibp = r.status === 500 && body.includes('Service not configured');
        return {
            name: 'check-email',
            ok: false,
            detail: isHibp
                ? 'HTTP 500 "Service not configured": la API key de HIBP esta vencida o invalida. '
                  + 'Renueva en haveibeenpwned.com/API/Key, actualiza HIBP_API_KEY en Vercel (Production) y redespliega.'
                : `HTTP ${r.status} ${body}`,
        };
    } catch (e) {
        return { name: 'check-email', ok: false, detail: `/api/check-email no respondió: ${e.name}` };
    }
}

function alertHtml(failures) {
    const rows = failures
        .map(f => `<li style="margin:0 0 10px;"><b>${f.name}</b>: ${f.detail}</li>`)
        .join('');
    return `<!doctype html><html><head><meta charset="utf-8"></head>`
        + `<body style="margin:0;background:#FAFAFA;">`
        + `<div style="max-width:560px;margin:0 auto;padding:32px 20px;`
        + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;`
        + `font-size:15px;line-height:1.6;color:#111;">`
        + `<p style="margin:0 0 20px;font-weight:700;font-size:17px;">Am I Exposed · chequeo diario</p>`
        + `<h1 style="margin:0 0 16px;font-size:21px;">Se detecto un fallo en produccion</h1>`
        + `<p style="margin:0 0 14px;">El chequeo automatico encontro ${failures.length} problema(s):</p>`
        + `<ul style="margin:0 0 20px;padding-left:20px;">${rows}</ul>`
        + `<p style="margin:24px 0 0;font-size:13px;color:#666;">`
        + `Chequeo de ${SITE} · ${new Date().toISOString()}. Este correo solo llega cuando algo falla.</p>`
        + `</div></body></html>`;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');

    // Fail closed. No secret configured means the monitor is simply off; a
    // configured secret must match. Neither reply carries any internal detail,
    // and the checks below never run for an unauthenticated caller, so no HIBP
    // quota is spent and no mail is sent on their behalf.
    const secret = process.env.CRON_SECRET;
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!secret) {
        return res.status(503).json({ error: 'Monitoring not configured' });
    }
    if (!secretMatches(bearer, secret)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const checks = await Promise.all([checkKeepalive(), checkEmailCheck()]);
    const failures = checks.filter(c => !c.ok);

    let alerted = false;
    const to = process.env.ALERT_EMAIL;
    if (failures.length && to) {
        alerted = await sendOpsAlert({
            to,
            subject: `[Am I Exposed] Fallo en produccion: ${failures.map(f => f.name).join(', ')}`,
            html: alertHtml(failures),
        });
    }

    // 503 when something is down, so an uptime pinger sees red too, not only the
    // inbox.
    return res.status(failures.length ? 503 : 200).json({
        ok: failures.length === 0,
        checks,
        alerted,
        alertEmailConfigured: !!to,
        at: new Date().toISOString(),
    });
}
