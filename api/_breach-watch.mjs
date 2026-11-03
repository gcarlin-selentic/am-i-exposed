// Pure core of the breach-alert feature: email validation, breach diffing and
// the decision of what (if anything) to tell the user. No I/O, no imports.

export function normalizeEmail(email) {
    return email.trim().toLowerCase();
}

// Same rule as check-email.js: rejects input that would waste an HIBP request.
export function isValidEmail(email) {
    return typeof email === 'string' &&
        email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Names in `returned` that are not in `known`, de-duplicated, in first-seen order.
export function newBreaches(returned, known) {
    const knownSet = new Set(known);
    const seen = new Set();
    const result = [];
    for (const name of returned) {
        if (knownSet.has(name) || seen.has(name)) continue;
        seen.add(name);
        result.push(name);
    }
    return result;
}

// Sorted, de-duplicated union of both lists.
export function mergeKnown(known, returned) {
    return [...new Set([...known, ...returned])].sort();
}

// First check for an address is a welcome with the full current exposure.
// Later checks alert only when there are names not seen before.
export function decideAction({ baselineDone, newNames, returnedNames }) {
    if (!baselineDone) {
        return { kind: 'welcome', breaches: returnedNames };
    }
    if (newNames.length > 0) {
        return { kind: 'alert', breaches: newNames };
    }
    return { kind: 'none' };
}

// Constant-time compare, same shape as healthcheck.js.
export function secretMatches(given, expected) {
    if (!expected || !given) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// True only for the exact header `Bearer <secret>`.
export function authorizeCron(authHeader, secret) {
    const prefix = 'Bearer ';
    if (typeof authHeader !== 'string' || !authHeader.startsWith(prefix)) return false;
    return secretMatches(authHeader.slice(prefix.length), secret);
}

// Runs one daily pass over the subscribers. A subscriber is only marked as
// notified after the mail was actually sent, so a failed send retries next day.
export async function processSubscribers({ subscribers, hibpLookup, sendWelcome, sendAlert, patch, now }) {
    const counts = { checked: 0, welcomed: 0, alerted: 0, errors: 0 };
    for (const sub of subscribers) {
        counts.checked++;
        const result = await hibpLookup(sub.email);
        if (result.status === 'error') {
            counts.errors++;
            continue;
        }
        const action = decideAction({
            baselineDone: sub.baseline_done,
            newNames: newBreaches(result.names, sub.known_breaches),
            returnedNames: result.names,
        });
        if (action.kind === 'none') {
            await patch(sub.id, { last_checked_at: now() });
            continue;
        }
        const sent = action.kind === 'welcome'
            ? await sendWelcome(sub, action.breaches)
            : await sendAlert(sub, action.breaches);
        if (!sent) {
            counts.errors++;
            continue;
        }
        await patch(sub.id, {
            known_breaches: mergeKnown(sub.known_breaches, result.names),
            baseline_done: true,
            last_checked_at: now(),
        });
        if (action.kind === 'welcome') counts.welcomed++;
        else counts.alerted++;
    }
    return counts;
}

// Decides what a signup does to the table under double opt-in. Nothing here
// activates a subscription: a new address is stored as pending, an unsubscribed
// one is asked to confirm again, and every other state is left alone so a
// repeat signup can never reset a subscriber. The endpoint attaches the
// confirm token.
export function planSignup(existingRow, { email, lang }) {
    const cleanLang = lang === 'en' ? 'en' : 'es';
    if (!existingRow) {
        return { action: 'insert', row: { email, lang: cleanLang, status: 'pending', plan: 'free_capture' } };
    }
    if (existingRow.status === 'unsubscribed') {
        return { action: 'reconfirm', patch: { status: 'pending', lang: cleanLang } };
    }
    return { action: 'noop' };
}

// Copy for the three breach-monitoring mails. Pure: they return plain text
// lines and a subject, never a URL. The sender adds the button and the footer
// through the mail layout, and escapes each line before it becomes HTML.
function names(list) {
    return (Array.isArray(list) ? list : []).join(', ');
}

export function breachConfirmCopy(lang) {
    if (lang === 'en') {
        return {
            subject: 'Confirm your breach monitoring',
            lines: [
                'You asked to be alerted if your email address shows up in a data breach.',
                'To turn the monitoring on, confirm with the button below.',
                'If you did not ask for this, ignore this email. Nothing is activated until you confirm.',
            ],
        };
    }
    return {
        subject: 'Confirma tu monitoreo de brechas',
        lines: [
            'Pediste que te avisemos si tu correo aparece en una filtración de datos.',
            'Para activar el monitoreo, confirma con el botón de abajo.',
            'Si no lo pediste tú, ignora este correo. No se activa nada hasta que confirmes.',
        ],
    };
}

export function breachWelcomeCopy(lang, breaches) {
    const found = names(breaches);
    if (lang === 'en') {
        return {
            subject: 'Your monitoring is active',
            lines: [
                'Your breach monitoring is on.',
                found
                    ? `Today your email appears in: ${found}.`
                    : 'Right now your email does not appear in any known breach.',
                'If it shows up in a new one, we will email you.',
            ],
        };
    }
    return {
        subject: 'Tu monitoreo está activo',
        lines: [
            'Tu monitoreo de brechas está activo.',
            found
                ? `Hoy apareces en: ${found}.`
                : 'Ahora mismo tu correo no aparece en ninguna filtración conocida.',
            'Si aparece en una nueva, te avisaremos por correo.',
        ],
    };
}

export function breachAlertCopy(lang, newBreaches) {
    const found = names(newBreaches);
    if (lang === 'en') {
        return {
            subject: 'You appeared in a new breach',
            lines: [
                `Your email address showed up in a new breach: ${found}.`,
                'Change the password you used on that service, and on any other site where you reused it. Turn on two-step verification where you can.',
                'This is monitoring, not a guarantee: we can only report breaches that have been made public.',
            ],
        };
    }
    return {
        subject: 'Apareciste en una filtración nueva',
        lines: [
            `Tu correo apareció en una filtración nueva: ${found}.`,
            'Cambia la contraseña que usabas en ese servicio y en cualquier otro sitio donde la repetiste. Activa la verificación en dos pasos donde puedas.',
            'Esto es monitoreo, no una garantía: solo podemos avisarte de filtraciones que ya son públicas.',
        ],
    };
}
