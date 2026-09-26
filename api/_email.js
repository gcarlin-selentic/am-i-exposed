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
// a bad day; a webhook that returns an error because of it would make Mercado
// Pago retry, and the money is already recorded by then. Every function below
// reports failure by returning false, never by throwing.

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

function sender() {
    const email = process.env.MAIL_FROM;
    if (!email) return null;
    return { email, name: process.env.MAIL_FROM_NAME || 'Am I Exposed?' };
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
        refundSubject: 'Devolución de tu compra en Am I Exposed?',
        refundTitle: 'Te devolvimos el dinero',
        refundLines: ({ amount, date }) => [
            'La devolución ya está en camino. Según tu banco, puede tardar unos días en aparecer.',
            `<b>Importe devuelto:</b> ${amount}<br><b>Fecha de la compra:</b> ${date}`,
            'Con la devolución, el acceso al plan completo queda cerrado.',
        ],
        footer: 'Selentic Group · Este es un correo automático, pero puedes responderlo.',
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
        refundSubject: 'Refund for your Am I Exposed? purchase',
        refundTitle: 'Your money is on its way back',
        refundLines: ({ amount, date }) => [
            'The refund has been issued. Depending on your bank it can take a few days to show up.',
            `<b>Amount refunded:</b> ${amount}<br><b>Purchase date:</b> ${date}`,
            'With the refund, access to the full plan is closed.',
        ],
        footer: 'Selentic Group · This is an automated message, but you can reply to it.',
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
                subject,
                htmlContent: html,
                textContent: stripHtml(html),
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            console.error('Mail send failed:', response.status, detail.slice(0, 200));
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
        buttonUrl: siteUrl,
        footer: escapeHtml(c.footer),
    });
    return send({ to, subject: c.receiptSubject, html });
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
