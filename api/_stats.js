// Daily usage counters.
//
// Vercel does not turn a file in /api whose name begins with an underscore
// into a route, so this is a module, not an endpoint.
//
// Four facts reach the database and nothing else: the day, the language, what
// was checked, and how it turned out, plus where the visitor came from. No
// address, no password, no IP, no account, and no row per visit. The table
// counts; it cannot be read backwards into a person.

const ORIGIN_MAX = 50;
const ORIGIN_UNKNOWN = 'desconocido';

// A referrer is a whole URL and a utm_source is free text from a stranger, so
// neither is believed. The host is enough to tell Google from LinkedIn, and
// anything that is not plain host-shaped is recorded as unknown rather than
// stored: it would be either a mistake or an attempt at something, and both
// would fragment the counters into near-duplicate rows.
export function normaliseOrigin(raw) {
    if (!raw || typeof raw !== 'string') return ORIGIN_UNKNOWN;

    let value = raw.trim().toLowerCase();
    if (!value || value.length > 300) return ORIGIN_UNKNOWN;

    if (value.includes('://')) {
        try {
            value = new URL(value).hostname.replace(/^www\./, '');
        } catch (e) {
            return ORIGIN_UNKNOWN;
        }
    }

    // Letters, digits, hyphen, dot and underscore. The underscore is here
    // because utm_source values carry it constantly (google_ads, paid_social),
    // and without it every one of those would have been filed as unknown.
    //
    // Rejected rather than stripped: cleaning a value up would let "goo gle!"
    // be filed as "google", which is a made-up number rather than a missing one.
    if (!/^[a-z0-9._-]{1,50}$/.test(value)) return ORIGIN_UNKNOWN;

    return value.slice(0, ORIGIN_MAX);
}

export function pickLang(value) {
    return value === 'en' ? 'en' : 'es';
}

// Returns a promise and never rejects. Callers send their response first and
// await this afterwards, which costs the visitor nothing and still gets the
// count written: the response is already flushed, and the serverless
// invocation stays alive until the handler's promise settles.
//
// Firing this without awaiting looks equivalent and is not. It was tried, and
// it dropped nearly every count: Vercel freezes the instance once the handler
// returns, and an unawaited fetch dies with it. A count is worth nothing
// beside somebody's result, but it is also worth nothing if it never lands.
export function recordCheck({ lang, tipo, resultado, origen }) {
    try {
        const url = process.env.SUPABASE_URL;
        const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !secret) return;

        // Guarded rather than trusted: these two decide which row is touched.
        // The database would reject anything else through its own check
        // constraints, so this only saves a pointless request.
        if (tipo !== 'correo' && tipo !== 'contrasena') return;
        if (resultado !== 'expuesto' && resultado !== 'limpio') return;

        const headers = { apikey: secret, 'Content-Type': 'application/json' };
        if (secret.startsWith('eyJ')) headers.Authorization = `Bearer ${secret}`;

        return fetch(`${url}/rest/v1/rpc/record_check`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                p_idioma: pickLang(lang),
                p_tipo: tipo,
                p_resultado: resultado,
                p_origen: normaliseOrigin(origen),
            }),
            // Eight seconds, not three. Three was measured at the edge: the
            // function runs in São Paulo and this round trip takes about two,
            // so most calls timed out and the counters stayed near empty.
            // The visitor already has their answer by now, so waiting longer
            // costs them nothing.
            signal: AbortSignal.timeout(8000),
        })
            .then(async (response) => {
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    console.error('record_check failed:', response.status, detail.slice(0, 160));
                }
            })
            .catch(error => console.error('record_check error:', error.name));
    } catch (error) {
        console.error('record_check skipped:', error.name);
    }
}
