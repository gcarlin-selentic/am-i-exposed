// The transactional mail the product sends on its own behalf: a receipt when a
// purchase is paid, and a notice when it is refunded. Supabase sends the
// account confirmation and the password link; those are separate and do not
// come through here.
//
// Vercel does not turn a file in /api whose name begins with an underscore into
// a route, so this is a module, not an endpoint.
//
// Sent through Brevo's HTTP API rather than SMTP because this project carries
// no dependencies and an SMTP client would be the first one.
//
// Nothing here is allowed to fail a payment. A receipt that does not arrive is
// a bad day; a webhook that returns an error because of it would make Stripe
// retry, and the money is already recorded by then. Every function below
// reports failure by returning false, never by throwing.

import { breachConfirmCopy, breachWelcomeCopy, breachAlertCopy } from './_breach-watch.mjs';

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

function sender() {
    const email = process.env.MAIL_FROM;
    if (!email) return null;
    return { email, name: process.env.MAIL_FROM_NAME || 'Am I Exposed?' };
}

// We send from a no-reply address; point replies at a monitored inbox so a
// customer who hits reply reaches us instead of a dead end.
function replyTo() {
    return {
        email: process.env.MAIL_REPLY_TO || 'support@am-i-exposed.com',
        name: process.env.MAIL_REPLY_TO_NAME || 'Am I Exposed Support',
    };
}

function pickLang(value) {
    return value === 'en' ? 'en' : 'es';
}

// Dates are for a person to read, not for a machine to parse.
function formatDate(iso, lang) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'es-PE',
            { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) {
        return String(iso).slice(0, 10);
    }
}

function formatAmount(amount, currency) {
    if (amount === null || amount === undefined) return '';
    const symbol = currency === 'PEN' ? 'S/ ' : `${currency || ''} `;
    return `${symbol}${Number(amount).toFixed(2)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// One plain layout for both messages. No images, no tracking, no marketing
// footer: this is a receipt, and a receipt that looks like an advert is the
// kind of mail people stop opening.
function layout({ title, lines, buttonLabel, buttonUrl, footer }) {
    const body = lines.map(line => `<p style="margin:0 0 14px;">${line}</p>`).join('');
    const button = buttonLabel && buttonUrl
        ? `<p style="margin:26px 0 0;"><a href="${escapeHtml(buttonUrl)}"
             style="background:#0098F2;color:#ffffff;text-decoration:none;
                    padding:12px 22px;border-radius:999px;display:inline-block;
                    font-weight:700;">${escapeHtml(buttonLabel)}</a></p>`
        : '';
    // Without the charset every accent in Spanish arrives as mojibake. Mail
    // clients do not all guess UTF-8, and "tu pago se acreditó" turning into
    // "acreditÃ³" on a receipt is the kind of detail that makes a business look
    // careless about the money it just took.
    return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#FAFAFA;">
<div style="max-width:520px;margin:0 auto;padding:32px 20px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
            font-size:15px;line-height:1.6;color:#111111;">
  <p style="margin:0 0 24px;font-weight:700;font-size:17px;">Am I Exposed?</p>
  <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;">${escapeHtml(title)}</h1>
  ${body}
  ${button}
  <p style="margin:32px 0 0;font-size:13px;color:#666666;">${footer}</p>
</div></body></html>`;
}

function stripHtml(html) {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const COPY = {
    es: {
        receiptSubject: 'Tu comprobante de Am I Exposed?',
        receiptTitle: 'Gracias por tu compra',
        receiptLines: ({ amount, date, expires }) => [
            'Tu pago se acreditó y tu plan de acción ya está disponible.',
            `<b>Importe:</b> ${amount}<br><b>Fecha:</b> ${date}`
            + (expires ? `<br><b>Acceso hasta:</b> ${expires}` : ''),
            'Entra con tu cuenta y vuelve a revisar tu correo para ver el plan completo. Puedes volver cuando quieras dentro de ese plazo.',
        ],
        receiptButton: 'Ver mi plan',
        reportLinkSubject: 'Tu Informe Completo está listo',
        reportLinkTitle: 'Tu Informe Completo está listo',
        reportLinkLines: [
            'Gracias por tu compra. Pulsa el botón de abajo para abrir tu Informe Completo: todo lo que quedó expuesto, un plan paso a paso para arreglarlo, y los acuerdos que tu correo podría reclamar.',
            'El enlace te identifica automáticamente y funciona durante la próxima hora. Tienes 30 días de acceso a tu informe. Si el enlace vence, responde este correo y te ayudamos.',
        ],
        reportLinkButton: 'Abrir mi Informe Completo',
        refundSubject: 'Devolución de tu compra en Am I Exposed?',
        refundTitle: 'Te devolvimos el dinero',
        refundLines: ({ amount, date }) => [
            'La devolución ya está en camino. Según tu banco, puede tardar unos días en aparecer.',
            `<b>Importe devuelto:</b> ${amount}<br><b>Fecha de la compra:</b> ${date}`,
            'Con la devolución, el acceso al plan completo queda cerrado.',
        ],
        footer: 'Guillermo Carlin · Este es un correo automático, pero puedes responderlo.',
    },
    en: {
        receiptSubject: 'Your Am I Exposed? receipt',
        receiptTitle: 'Thank you for your purchase',
        receiptLines: ({ amount, date, expires }) => [
            'Your payment went through and your action plan is ready.',
            `<b>Amount:</b> ${amount}<br><b>Date:</b> ${date}`
            + (expires ? `<br><b>Access until:</b> ${expires}` : ''),
            'Sign in and check your email address again to see the full plan. You can come back any time within that period.',
        ],
        receiptButton: 'See my plan',
        reportLinkSubject: 'Your Full Report is ready',
        reportLinkTitle: 'Your Full Report is ready',
        reportLinkLines: [
            'Thanks for your purchase. Click the button below to open your Full Report: everything that was exposed, a step-by-step plan to fix it, and the settlements your email may be owed.',
            'The link signs you in automatically and works for the next hour. You have 30 days of access to your report. If the link expires, just reply to this email and we will help.',
        ],
        reportLinkButton: 'Open my Full Report',
        refundSubject: 'Refund for your Am I Exposed? purchase',
        refundTitle: 'Your money is on its way back',
        refundLines: ({ amount, date }) => [
            'The refund has been issued. Depending on your bank it can take a few days to show up.',
            `<b>Amount refunded:</b> ${amount}<br><b>Purchase date:</b> ${date}`,
            'With the refund, access to the full plan is closed.',
        ],
        footer: 'Guillermo Carlin · This is an automated message, but you can reply to it.',
    },
};

async function send({ to, subject, html }) {
    const apiKey = process.env.BREVO_API_KEY;
    const from = sender();
    if (!apiKey || !from || !to) {
        console.error('Mail not configured:', { key: !!apiKey, from: !!from, to: !!to });
        return false;
    }

    try {
        const response = await fetch(BREVO_API, {
            method: 'POST',
            headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sender: from,
                to: [{ email: to }],
                replyTo: replyTo(),
                subject,
                htmlContent: html,
                textContent: stripHtml(html),
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            // Status only: Brevo's body can echo the recipient address.
            console.error('Mail send failed, status:', response.status);
            return false;
        }
        return true;
    } catch (error) {
        console.error('Mail send error:', error.name);
        return false;
    }
}

export async function sendReceipt({ to, lang, amount, currency, paidAt, expiresAt, siteUrl }) {
    const l = pickLang(lang);
    const c = COPY[l];
    const html = layout({
        title: c.receiptTitle,
        lines: c.receiptLines({
            amount: escapeHtml(formatAmount(amount, currency)),
            date: escapeHtml(formatDate(paidAt, l)),
            expires: escapeHtml(formatDate(expiresAt, l)),
        }),
        buttonLabel: c.receiptButton,
        // ?plan=1 opens the plan straight away instead of dropping the buyer on
        // the front page to find it themselves. The address is not in the link:
        // the page reads it from their session.
        buttonUrl: siteUrl ? `${siteUrl}/?plan=1` : null,
        footer: escapeHtml(c.footer),
    });
    return send({ to, subject: c.receiptSubject, html });
}

// Guest report checkout: the buyer paid without an account, so this is how they
// reach the report. actionLink is the GoTrue magic link that signs their
// silently-created account in; the address is never in a query string.
export async function sendReportLink({ to, lang, actionLink }) {
    const l = pickLang(lang);
    const c = COPY[l];
    if (!actionLink) return false;
    const html = layout({
        title: c.reportLinkTitle,
        lines: c.reportLinkLines,
        buttonLabel: c.reportLinkButton,
        buttonUrl: actionLink,
        footer: escapeHtml(c.footer),
    });
    return send({ to, subject: c.reportLinkSubject, html });
}

export async function sendRefundNotice({ to, lang, amount, currency, paidAt }) {
    const l = pickLang(lang);
    const c = COPY[l];
    const html = layout({
        title: c.refundTitle,
        lines: c.refundLines({
            amount: escapeHtml(formatAmount(amount, currency)),
            date: escapeHtml(formatDate(paidAt, l)),
        }),
        footer: escapeHtml(c.footer),
    });
    return send({ to, subject: c.refundSubject, html });
}

// An alert to ourselves, not a customer: the daily health check uses it to
// report a production failure. Reuses the same Brevo path and the same contract
// as the receipts above, so it returns false instead of throwing. The caller
// builds its own HTML, because an ops alert shares nothing with a receipt's
// layout.
export async function sendOpsAlert({ to, subject, html }) {
    return send({ to, subject, html });
}

// Settlement digest. The subject/html are built by _settlement-alerts.mjs
// (already escaped and self-contained), so this just hands them to send().
// Same contract: false on failure, never a throw.
export async function sendSettlementAlert({ to, subject, html }) {
    return send({ to, subject, html });
}

// Breach monitoring mail. The copy comes from the pure builders in
// _breach-watch.mjs as plain text, so each line is escaped here before it
// becomes HTML. Same contract as above: false on failure, never a throw.
const BREACH_UI = {
    es: {
        confirmTitle: 'Confirma tu monitoreo',
        confirmButton: 'Confirmar',
        confirmFooter: 'Si no fuiste tú, ignora este correo.',
        welcomeTitle: 'Tu monitoreo está activo',
        alertTitle: 'Apareciste en una filtración nueva',
        siteButton: 'Ver mi exposición',
        unsubscribe: 'Para dejar de recibir estos avisos:',
        unsubscribeLink: 'darte de baja',
    },
    en: {
        confirmTitle: 'Confirm your monitoring',
        confirmButton: 'Confirm',
        confirmFooter: 'If this was not you, ignore this email.',
        welcomeTitle: 'Your monitoring is active',
        alertTitle: 'You appeared in a new breach',
        siteButton: 'See my exposure',
        unsubscribe: 'To stop receiving these alerts:',
        unsubscribeLink: 'unsubscribe',
    },
};

function breachFooter(ui, unsubscribeUrl) {
    if (!unsubscribeUrl) return escapeHtml(ui.unsubscribe);
    return `${escapeHtml(ui.unsubscribe)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#666666;">${escapeHtml(ui.unsubscribeLink)}</a>`;
}

export async function sendBreachConfirm({ to, lang, confirmUrl }) {
    const l = pickLang(lang);
    const ui = BREACH_UI[l];
    const copy = breachConfirmCopy(l);
    const html = layout({
        title: ui.confirmTitle,
        lines: copy.lines.map(escapeHtml),
        buttonLabel: ui.confirmButton,
        buttonUrl: confirmUrl,
        footer: escapeHtml(ui.confirmFooter),
    });
    return send({ to, subject: copy.subject, html });
}

export async function sendBreachWelcome({ to, lang, breaches, siteUrl, unsubscribeUrl }) {
    const l = pickLang(lang);
    const ui = BREACH_UI[l];
    const copy = breachWelcomeCopy(l, breaches);
    const html = layout({
        title: ui.welcomeTitle,
        lines: copy.lines.map(escapeHtml),
        buttonLabel: ui.siteButton,
        buttonUrl: siteUrl || null,
        footer: breachFooter(ui, unsubscribeUrl),
    });
    return send({ to, subject: copy.subject, html });
}

export async function sendBreachAlert({ to, lang, newBreaches, siteUrl, unsubscribeUrl }) {
    const l = pickLang(lang);
    const ui = BREACH_UI[l];
    const copy = breachAlertCopy(l, newBreaches);
    const html = layout({
        title: ui.alertTitle,
        lines: copy.lines.map(escapeHtml),
        buttonLabel: ui.siteButton,
        buttonUrl: siteUrl || null,
        footer: breachFooter(ui, unsubscribeUrl),
    });
    return send({ to, subject: copy.subject, html });
}
