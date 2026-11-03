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
