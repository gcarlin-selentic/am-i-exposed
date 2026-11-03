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
