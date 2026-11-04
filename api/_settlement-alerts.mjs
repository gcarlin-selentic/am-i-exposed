// Pure selection and formatting for the paid settlement alert. No I/O, so it is
// unit-tested on its own (api/_settlement-alerts.test.mjs). The run handler
// (api/_run-settlements.mjs) does the Supabase/Brevo wiring and calls this.
//
// The product is a monitoring service, not a promise of money: an item's amount
// is the administrator's own published figure, verbatim ("up to $X", a range),
// never summed or computed here.

// Cases the scraper mis-flags as data breaches. Hyundai/Kia is the standing one:
// its open settlement is the anti-theft (car-theft) class action, not a data
// breach, so it must never reach a data-breach alert.
const NON_BREACH_TOKENS = new Set(['hyundai', 'kia']);

function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKD')
        .replace(/[^a-z0-9]+/g, ' ').trim();
}

function isNonBreach(empresa) {
    return norm(empresa).split(' ').some(t => NON_BREACH_TOKENS.has(t));
}

export function isClaimableBreach(row, todayISO) {
    return row.filtracion === true
        && typeof row.plazo === 'string' && row.plazo >= todayISO
        && !isNonBreach(row.empresa);
}

// A stable id per settlement, for per-subscriber dedup. The claim-site host is
// the most stable key; fall back to the company and deadline when it is missing.
export function settlementId(row) {
    const site = norm(row.sitio_reclamo).replace(/\s+/g, '');
    if (site) return site;
    return norm(row.empresa).replace(/\s+/g, '-') + '-' + (row.plazo || '');
}

export function toAlertItem(row) {
    return {
        id: settlementId(row),
        company: row.empresa,
        amount: row.pago_texto || null,   // verbatim; never computed
        deadlineISO: row.plazo,
        site: row.sitio_reclamo || null,
        cubre: row.cubre || null,
    };
}

// What to send a subscriber: every currently-claimable settlement they have not
// been alerted about yet. `welcome` is true on first contact (nothing sent yet),
// so the first email catches them up on everything open now.
export function selectForSubscriber(openRows, alreadySentIds, todayISO) {
    const sent = new Set(alreadySentIds || []);
    const items = (openRows || [])
        .filter(r => isClaimableBreach(r, todayISO))
        .filter(r => !sent.has(settlementId(r)))
        .map(toAlertItem);
    return { welcome: sent.size === 0, items };
}

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function prettyDate(iso, lang) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y) return '';
    try {
        return new Date(y, m - 1, d).toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US',
            { year: 'numeric', month: 'long', day: 'numeric' });
    } catch { return iso; }
}

const EMAIL_COPY = {
    en: {
        subjWelcome: 'Settlements open now you may be able to claim',
        subjNew: n => `${n} new settlement${n === 1 ? '' : 's'} you may be able to claim`,
        lead: 'These US data-breach settlements are open. You may be able to claim if you were a customer, patient, or employee of the company during the affected period. We are not lawyers and we do not file for you; we link only to the official administrator.',
        claimBy: 'Claim by',
        claimAt: 'Claim at the official site',
        foot: 'We watch these settlements and tell you when a new one opens. You get this because you subscribed to settlement monitoring. Nothing here is a promise of money.',
        unsub: 'Unsubscribe',
    },
    es: {
        subjWelcome: 'Acuerdos abiertos ahora que podrias reclamar',
        subjNew: n => `${n} acuerdo${n === 1 ? '' : 's'} nuevo${n === 1 ? '' : 's'} que podrias reclamar`,
        lead: 'Estos acuerdos por brechas de datos en EE. UU. estan abiertos. Podrias reclamar si fuiste cliente, paciente o empleado de la empresa en el periodo afectado. No somos abogados y no reclamamos por ti; solo enlazamos al administrador oficial.',
        claimBy: 'Reclama hasta',
        claimAt: 'Reclamar en el sitio oficial',
        foot: 'Vigilamos estos acuerdos y te avisamos cuando se abre uno nuevo. Recibes esto porque te suscribiste al monitoreo. Nada aqui es una promesa de dinero.',
        unsub: 'Cancelar el aviso',
    },
};

// The alert email. Amounts are the administrator's own published figure
// (`item.amount`), rendered verbatim and never summed or implied as owed. An
// unsubscribe link is always included (CAN-SPAM, and the owner-consent mitigation
// for the email-based model).
export function buildAlertEmail({ items, welcome, lang, unsubscribeUrl }) {
    const l = lang === 'es' ? 'es' : 'en';
    const c = EMAIL_COPY[l];
    const subject = welcome ? c.subjWelcome : c.subjNew(items.length);
    const rows = (items || []).map(it => {
        const link = it.site
            ? `<a href="https://${esc(it.site)}" style="color:#0077C2;">${esc(c.claimAt)}: ${esc(it.site)}</a>`
            : '';
        const when = it.deadlineISO ? `<div style="color:#6B6B70;font-size:13px;">${esc(c.claimBy)} ${esc(prettyDate(it.deadlineISO, l))}</div>` : '';
        return `<div style="border:1px solid #e5e5e5;border-radius:12px;padding:14px 16px;margin:0 0 12px;">
  <div style="font-weight:700;">${esc(it.company)}${it.amount ? ` &middot; ${esc(it.amount)}` : ''}</div>
  ${it.cubre ? `<div style="color:#444;font-size:14px;margin:4px 0 0;">${esc(it.cubre)}</div>` : ''}
  ${when}
  <div style="margin-top:6px;">${link}</div>
</div>`;
    }).join('');
    const unsub = unsubscribeUrl
        ? `<p style="margin:10px 0 0;font-size:13px;color:#666;"><a href="${esc(unsubscribeUrl)}" style="color:#666;">${esc(c.unsub)}</a></p>`
        : '';
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#FAFAFA;">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;">
  <p style="font-weight:700;font-size:17px;margin:0 0 16px;">Am I Exposed?</p>
  <p style="margin:0 0 18px;">${esc(c.lead)}</p>
  ${rows}
  <p style="margin:24px 0 0;font-size:13px;color:#666;">${esc(c.foot)}</p>
  ${unsub}
</div></body></html>`;
    return { subject, html };
}
