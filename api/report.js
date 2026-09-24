// Vercel serverless function: /api/report
//
// Builds the personalised action plan on the server. This is deliberately not
// done in the browser: the plan is the paid product, so the full text must
// never be sent to someone who has not bought it. Unpaid callers get a teaser
// (the first action in full, plus the titles of the rest) and nothing more.
//
// The plan is written in the language the caller asks for. Keeping both
// languages here rather than in the page means the paid prose stays on the
// server in every language, not only in English.

const HIBP_ENDPOINT = 'https://haveibeenpwned.com/api/v3/breachedaccount';

// Publishable key. Already public in the page source; used only to satisfy the
// apikey header when asking Supabase to identify a user's access token.
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
    || 'sb_publishable_agkPOONNtck7k-an-rpwOg_GTXoo5de';

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const hits = new Map();

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

function isAllowedOrigin(origin, host) {
    if (!origin) return true;
    if (host) {
        try {
            if (new URL(origin).host === host) return true;
        } catch {
            return false;
        }
    }
    const configured = process.env.ALLOWED_ORIGINS;
    if (!configured) return false;
    return configured.split(',').map(o => o.trim()).filter(Boolean).includes(origin);
}

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) {
        for (const [k, times] of hits) {
            if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) hits.delete(k);
        }
    }
    return recent.length > RATE_LIMIT_MAX;
}

function isValidEmail(email) {
    return typeof email === 'string'
        && email.length <= 254
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function safeParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

// Only two languages are written here, so anything else falls back to English
// rather than producing a plan with missing sentences.
function pickLang(value) {
    return value === 'es' ? 'es' : 'en';
}

// ---------------------------------------------------------------------------
// Identity and entitlement
// ---------------------------------------------------------------------------

// Resolves a Supabase access token to a user, by asking Supabase. Never trusts
// anything the browser claims about who it is.
async function userFromToken(accessToken) {
    const url = process.env.SUPABASE_URL;
    if (!url || !accessToken || typeof accessToken !== 'string') return null;

    try {
        const response = await fetch(`${url}/auth/v1/user`, {
            headers: {
                apikey: SUPABASE_PUBLISHABLE_KEY,
                Authorization: `Bearer ${accessToken}`,
            },
            signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) return null;
        const user = await response.json();
        return user && user.id ? user : null;
    } catch (error) {
        console.error('Token check failed:', error.name);
        return null;
    }
}

// Reads the purchases table with the secret key, bypassing RLS. Fails closed:
// if we cannot confirm a purchase, the caller is not entitled.
async function hasActiveAccess(userId) {
    const url = process.env.SUPABASE_URL;
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !secret || !userId) return false;

    const headers = { apikey: secret };
    if (secret.startsWith('eyJ')) headers.Authorization = `Bearer ${secret}`;

    const query = `${url}/rest/v1/purchases`
        + `?select=expires_at`
        + `&user_id=eq.${encodeURIComponent(userId)}`
        + `&status=eq.paid`
        + `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(new Date().toISOString())})`
        + `&limit=1`;

    try {
        const response = await fetch(query, { headers, signal: AbortSignal.timeout(4000) });
        if (!response.ok) {
            console.error('Entitlement lookup failed:', response.status);
            return false;
        }
        const rows = await response.json();
        return Array.isArray(rows) && rows.length > 0;
    } catch (error) {
        console.error('Entitlement lookup error:', error.name);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Breach data
// ---------------------------------------------------------------------------

async function fetchBreaches(email) {
    const apiKey = process.env.HIBP_API_KEY;
    if (!apiKey) throw Object.assign(new Error('not configured'), { code: 'CONFIG' });

    const response = await fetch(
        `${HIBP_ENDPOINT}/${encodeURIComponent(email)}?truncateResponse=false`,
        { method: 'GET', headers: { 'User-Agent': 'Am-I-Exposed-Check', 'hibp-api-key': apiKey } }
    );

    if (response.status === 404) return [];
    if (response.status === 429) throw Object.assign(new Error('rate limited'), { code: 'RATE' });
    if (!response.ok) throw Object.assign(new Error('upstream'), { code: 'UPSTREAM' });

    const raw = await response.json();
    return raw.map(b => ({
        name: b.Name,
        title: b.Title || b.Name,
        domain: b.Domain || null,
        breachDate: b.BreachDate || null,
        pwnCount: b.PwnCount || null,
        dataClasses: b.DataClasses || [],
        isStealerLog: b.IsStealerLog === true,
    })).sort((a, b) => (b.breachDate || '').localeCompare(a.breachDate || ''));
}

// Fictional data for preview mode. Chosen to trigger every rule below.
const DEMO_BREACHES = [
    { name: 'DemoStealerLogs', title: 'Sample Stealer Logs', domain: null, breachDate: '2026-04-11', pwnCount: 284132969, isStealerLog: true,
      dataClasses: ['Email addresses', 'Passwords'] },
    { name: 'DemoRetail', title: 'Northwind Outfitters', domain: 'example.com', breachDate: '2026-08-13', pwnCount: 12933413, isStealerLog: false,
      dataClasses: ['Email addresses', 'Passwords', 'Names', 'Phone numbers', 'Physical addresses'] },
    { name: 'DemoGov', title: 'Sample Services Portal', domain: 'example.org', breachDate: '2025-02-01', pwnCount: 5041233, isStealerLog: false,
      dataClasses: ['Government issued IDs', 'Dates of birth', 'Physical addresses', 'Names'] },
    { name: 'DemoShop', title: 'Sample Marketplace', domain: 'example.net', breachDate: '2024-06-01', pwnCount: 903411, isStealerLog: false,
      dataClasses: ['Credit cards', 'Email addresses', 'Payment histories'] },
    { name: 'DemoForum', title: 'Sample Forum', domain: 'example.com', breachDate: '2014-09-22', pwnCount: 393430309, isStealerLog: false,
      dataClasses: ['Security questions and answers', 'Passwords', 'Email addresses'] },
    { name: 'DemoClinic', title: 'Sample Health Group', domain: null, breachDate: '2023-11-05', pwnCount: 411902, isStealerLog: false,
      dataClasses: ['Health insurance information', 'Names', 'Dates of birth'] },
];

// ---------------------------------------------------------------------------
// The plan itself
// ---------------------------------------------------------------------------

const CLASS_GROUPS = {
    passwords: ['Passwords', 'Historical passwords'],
    security: ['Security questions and answers'],
    financial: ['Credit cards', 'Credit card CVV', 'Partial credit card data', 'Bank account numbers', 'Payment histories', 'Historical payment information'],
    identity: ['Social security numbers', 'National identification numbers', 'Government issued IDs', 'Passport numbers', "Driver's licenses", 'Tax records'],
    phone: ['Phone numbers'],
    address: ['Physical addresses', 'Geographic locations'],
    dob: ['Dates of birth'],
    health: ['Health insurance information', 'Medical conditions', 'Medical records'],
};

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const hasClass = (b, g) => (Array.isArray(b.dataClasses) ? b.dataClasses : []).some(c => CLASS_GROUPS[g].includes(c));

function monthsAgo(dateStr) {
    if (!dateStr) return null;
    const t = Date.parse(dateStr);
    return isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / MONTH_MS));
}

// ---------------------------------------------------------------------------
// Plan copy, in both languages.
//
// Anything that varies with the data is a function taking the counts and the
// already-formatted site list, so the two languages can order a sentence
// differently instead of being forced into English word order.
// ---------------------------------------------------------------------------

const PLAN_TEXT = {
    en: {
        unnamed: 'an unnamed breach',
        andMore: (n) => `, and ${n} more`,

        stealer: {
            time: 'About 20 minutes',
            title: 'Check your computer for a virus first',
            whatHappened: 'Your email address and a password turned up in a list that was made by a virus. This kind of virus sits quietly on a computer and copies everything the person types, including passwords.',
            whyItMatters: 'If that virus is still on your computer, there is no point changing your passwords yet. It would simply copy the new ones too. So this comes before everything else on the list.',
            steps: [
                'For now, use a different device. Your phone or a tablet is fine. Do the rest of this list on that, not on your usual computer.',
                'On a Windows computer: click the Start button, type the words Windows Security, and press Enter. Choose "Virus & threat protection", then click "Quick scan". Let it finish.',
                'On a Mac: open any antivirus program you already have and run a full scan. If you do not have one, ask someone you trust to help you check the computer.',
                'Open your web browser. In its menu, look for "Extensions" or "Add-ons". Remove anything you do not remember adding yourself.',
                'If the scan finds something, let it remove it, then restart the computer.',
                'Only after the computer is clean, come back and do the password steps below.',
            ],
        },

        recentPasswords: (n, sitesAll, sitesShort) => ({
            time: 'About 5 minutes for each website',
            title: 'Change your password on these websites',
            whatHappened: `${n} website${n > 1 ? 's were' : ' was'} broken into in the last two years, and your password was taken: ${sitesAll}.`,
            whyItMatters: 'These lists get bought and sold. Criminals take your email address and that password, then try the pair on other websites, such as your bank or your email, hoping you used the same one twice.',
            steps: [
                `Go to each of these websites and change your password: ${sitesShort}.`,
                'Usually you find this under "Settings", then "Password" or "Security". If you cannot find it, search the website for the words "change password".',
                'Give each website a different password. Never the same one twice.',
                'Now the important part: if you used that same password anywhere else, change it there too. Especially your email and your bank.',
                'A good password is three ordinary words joined together, like purple-tractor-window. Long is better than complicated. You do not need symbols and capital letters to be safe.',
            ],
        }),

        oldPasswords: (n, sites) => ({
            time: 'About 5 minutes for each website',
            title: 'Change any old password you still use',
            whatHappened: `${n} of the websites you were on lost passwords, though none of them recently. They were ${sites}.`,
            whyItMatters: 'Old lists never go away. If you are still using one of those passwords somewhere today, it is still a risk. If you stopped using it years ago, you can relax about this one.',
            steps: [
                'Think about whether you still use any of those old passwords anywhere.',
                'If you do, change it on those accounts. Start with your email and your bank.',
                'If you have not used those passwords in years, you can skip this step.',
            ],
        }),

        email: {
            time: 'About 15 minutes',
            title: 'Protect your email account before anything else',
            whatHappened: 'Nothing has gone wrong with your email account specifically. This step is on the list because your email protects everything else you own.',
            whyItMatters: 'Think of your email as the spare key to your whole life. If someone gets into it, they can go to your bank, your shopping accounts, anything at all, and click "forgot my password". The reset link arrives in your email, which they are now reading. So they get in everywhere.',
            steps: [
                'Give your email a password you do not use on any other website.',
                'Turn on the second step for logging in. This means that after you type your password, the website also sends a short code to your phone. Even if a criminal knows your password, they cannot get in without your phone in their hand.',
                'If you use Gmail: go to myaccount.google.com, click "Security" on the left, then find "2-Step Verification" and follow the instructions.',
                'If you use Outlook or Hotmail: go to account.microsoft.com, click "Security", then "Two-step verification".',
                'While you are in your email settings, look for "Forwarding". Make sure your mail is not being copied to an address you do not recognise. Someone who breaks in often sets this up so they keep reading your mail even after you change the password.',
                'Also check the "recovery" phone number and email address listed there, and make sure both belong to you.',
            ],
        },

        securityQs: (n, sites) => ({
            time: 'About 10 minutes',
            title: 'Change your security questions',
            whatHappened: `${n} website${n > 1 ? 's' : ''} lost the answers to your security questions. These are the questions like "what was your mother's maiden name" or "what was the name of your first pet". The website was ${sites}.`,
            whyItMatters: 'Changing your password does not help if somebody can simply click "forgot my password" and then answer those questions correctly. They already have your answers.',
            steps: [
                'On your important accounts, go into the security settings and change the answers to these questions.',
                'Do not put the true answer. Make something up instead. For "first pet" you could answer blue curtain. Nobody will ever guess that, because it is not true.',
                'Write your made-up answers down and keep the note somewhere safe. On paper in a drawer at home is perfectly fine.',
            ],
        }),

        identity: (n, sites) => ({
            time: 'About 30 minutes',
            title: 'Stop anyone opening accounts in your name',
            whatHappened: `${n === 1 ? 'One of the break-ins' : `${n} of the break-ins`} included your identity number, such as a national ID, social security or passport number. ${n > 1 ? 'They were' : 'It was'} ${sites}.`,
            whyItMatters: 'You can change a password whenever you like. You cannot change your ID number. Somebody could use it, along with your name and address, to open a credit card or take out a loan pretending to be you.',
            steps: [
                'Contact the credit agencies in your country and ask for a credit freeze. Some countries call it a security freeze or a credit lock.',
                'It is free, and you can do it by phone or on their website.',
                'A freeze means nobody can open a new account in your name. Not a criminal, and not you either, until you lift it.',
                'It does not affect the cards and accounts you already have, and it does not harm your credit score.',
                'If you need a loan or a new card later, you can lift the freeze for a few days and then put it back.',
                'Open every letter about an account you did not open, rather than assuming it is junk mail. That letter is usually the first warning sign.',
            ],
        }),

        financial: (n, sites) => ({
            time: 'About 20 minutes',
            title: 'Check your bank and card statements',
            whatHappened: `${n === 1 ? 'One of the break-ins' : `${n} of the break-ins`} included card or bank details: ${sites}.`,
            whyItMatters: 'Card numbers are often only partly included, but combined with your name and address that can be enough for somebody to make a purchase.',
            steps: [
                'Look through your last three statements, line by line.',
                'Pay attention to small amounts you do not recognise, even one or two pounds or dollars. Criminals test a stolen card with a tiny purchase first, and only spend properly if it works.',
                'If you see anything you do not recognise, however small, phone the number on the back of your card.',
                'Ask your bank to send you a text message every time the card is used. Then you hear about a problem the same day instead of at the end of the month.',
                'If you used one of those cards on the websites above and still have it, ask the bank to send you a new card number.',
            ],
        }),

        phone: (n) => ({
            time: 'About 15 minutes',
            title: 'Protect your phone number',
            whatHappened: `Your phone number was included in ${n === 1 ? 'one of the break-ins' : `${n} of the break-ins`}.`,
            whyItMatters: 'This is why you get so many nuisance calls and texts. There is a more serious risk as well. Someone can telephone your mobile company, pretend to be you, and ask them to move your number onto a new SIM card in their possession. If they manage it, the security codes your bank sends by text go to them instead of you.',
            steps: [
                'Phone your mobile company. Ask them to put a PIN or a password on your account, so that nobody can move your number to another SIM without it.',
                'Say these exact words if it helps: "Please add a port-out PIN to my account." They will know what you mean.',
                'If a call or a text claims to be from your bank, hang up. Then telephone the number printed on the back of your card. A real bank will never mind you doing this.',
                'Never read a security code out to somebody who telephones you. Those codes are for you to type in, never to say out loud.',
            ],
        }),

        // With a single break-in there is no "of them" to point at, so the
        // counts are dropped rather than rendered as "in one of them".
        scamsParts: {
            address: (n, total) => total === 1 ? 'your home address' : `your home address in ${n === 1 ? 'one of them' : `${n} of them`}`,
            dob: (n, total) => total === 1 ? 'your date of birth' : `your date of birth in ${n === 1 ? 'one' : n}`,
        },
        scamsJoin: ' and ',
        scams: (parts, total) => ({
            time: 'Nothing to install, just worth reading',
            title: 'Expect scams that sound very convincing',
            whatHappened: `${total === 1 ? 'The break-in included' : 'The break-ins included'} ${parts}.`,
            whyItMatters: 'This is what makes modern scams work so well. A letter, email or phone call that already knows your name, your address and your birthday does not feel like a scam. It feels official. That is exactly the trick.',
            steps: [
                'When a message already knows your personal details, treat it as more suspicious, not less. Knowing your details proves nothing any more.',
                'Never click a link in a message about one of your accounts. Close it, and open the app or type the website address in yourself.',
                'If somebody telephones and asks you to move money, buy gift cards, or read out a code, it is a scam every single time. Put the phone down. You are not being rude.',
                'If a message makes you feel rushed or frightened, that is deliberate. Take an hour. Real organisations will wait.',
                'When in doubt, telephone somebody you trust and describe the message to them before you do anything.',
            ],
        }),

        health: (n, sites) => ({
            time: 'About 15 minutes',
            title: 'Keep an eye on your medical bills',
            whatHappened: `${n === 1 ? 'One of the break-ins' : `${n} of the break-ins`} included health or insurance information: ${sites}.`,
            whyItMatters: 'Somebody could use your details to get treatment or claim on your insurance. This takes much longer to notice than money going missing from a bank account, and it is more difficult to put right.',
            steps: [
                'Read the statements your health insurer sends you instead of filing them away unopened.',
                'Look for appointments, treatments or prescriptions you did not have.',
                'Telephone your insurer about anything you do not recognise, even if it seems minor.',
            ],
        }),

        manager: (total) => ({
            time: 'About 20 minutes to set up',
            title: 'Let your phone remember your passwords for you',
            whatHappened: `Your email address turned up in ${total} break-in${total > 1 ? 's' : ''} in total. More companies will be broken into in future. None of that is your fault and you cannot prevent it.`,
            whyItMatters: 'Nobody can remember a different password for every website, so most people use the same one over and over. That is the real problem: one company loses your password, and suddenly everything else you own is unlocked with it. Something that remembers your passwords for you fixes this completely.',
            steps: [
                'You very likely already have one. Your phone and your web browser can both remember passwords for you.',
                'Next time a website asks "Would you like to save this password?", say yes.',
                'When it offers to make up a password for you, let it. It does not matter that the password looks like nonsense, because you will never have to type it.',
                'You only need to remember one password: the one that unlocks your phone or your browser.',
                'Make that one long, and never use it anywhere else. Three ordinary words joined together works well.',
                'Start with your email and your bank. You do not need to fix every account today. A few each week is perfectly good progress.',
            ],
        }),
    },

    es: {
        unnamed: 'una filtración sin nombre',
        andMore: (n) => `, y ${n} más`,

        stealer: {
            time: 'Unos 20 minutos',
            title: 'Primero revisa si tu computador tiene un virus',
            whatHappened: 'Tu correo y una contraseña aparecieron en una lista hecha por un virus. Este tipo de virus se queda callado dentro de un computador y copia todo lo que la persona escribe, incluidas las contraseñas.',
            whyItMatters: 'Si ese virus sigue en tu computador, no sirve de nada cambiar las contraseñas todavía: copiaría también las nuevas. Por eso este paso va antes que todos los demás.',
            steps: [
                'Por ahora usa otro aparato. Tu teléfono o una tableta sirven. Haz el resto de esta lista ahí, no en tu computador de siempre.',
                'Si tu computador es Windows: haz clic en el botón de Inicio, escribe las palabras Seguridad de Windows y presiona Enter. Elige "Protección antivirus y contra amenazas" y luego "Examen rápido". Déjalo terminar.',
                'Si es un Mac: abre el antivirus que ya tengas y haz un examen completo. Si no tienes ninguno, pídele a alguien de confianza que te ayude a revisar el computador.',
                'Abre tu navegador de internet. En su menú busca "Extensiones" o "Complementos". Quita todo lo que no recuerdes haber instalado tú.',
                'Si el examen encuentra algo, deja que lo elimine y reinicia el computador.',
                'Solo cuando el computador esté limpio, vuelve y haz los pasos de contraseñas que siguen.',
            ],
        },

        recentPasswords: (n, sitesAll, sitesShort) => ({
            time: 'Unos 5 minutos por cada sitio',
            title: 'Cambia tu contraseña en estos sitios',
            whatHappened: `${n === 1 ? 'Un sitio fue atacado' : `${n} sitios fueron atacados`} en los últimos dos años y se llevaron tu contraseña: ${sitesAll}.`,
            whyItMatters: 'Esas listas se compran y se venden. Los delincuentes toman tu correo junto con esa contraseña y prueban la pareja en otros sitios, como tu banco o tu correo, esperando que hayas usado la misma dos veces.',
            steps: [
                `Entra a cada uno de estos sitios y cambia tu contraseña: ${sitesShort}.`,
                'Casi siempre está en "Configuración" y después "Contraseña" o "Seguridad". Si no lo encuentras, busca dentro del sitio las palabras "cambiar contraseña".',
                'Ponle a cada sitio una contraseña distinta. Nunca la misma dos veces.',
                'Ahora lo importante: si usaste esa misma contraseña en otro lado, cámbiala ahí también. Sobre todo en tu correo y en tu banco.',
                'Una buena contraseña son tres palabras normales pegadas, como morado-tractor-ventana. Larga es mejor que complicada. No necesitas símbolos ni mayúsculas para estar seguro.',
            ],
        }),

        oldPasswords: (n, sites) => ({
            time: 'Unos 5 minutos por cada sitio',
            title: 'Cambia cualquier contraseña vieja que todavía uses',
            whatHappened: `${n === 1 ? 'Uno de los sitios' : `${n} de los sitios`} en los que estuviste perdió contraseñas, aunque ninguno recientemente. ${n === 1 ? 'Fue' : 'Fueron'} ${sites}.`,
            whyItMatters: 'Las listas viejas nunca desaparecen. Si todavía usas una de esas contraseñas en algún lado, el riesgo sigue vivo. Si dejaste de usarla hace años, este punto puedes tomarlo con calma.',
            steps: [
                'Piensa si todavía usas alguna de esas contraseñas viejas en algún lado.',
                'Si es así, cámbiala en esas cuentas. Empieza por tu correo y tu banco.',
                'Si hace años que no usas esas contraseñas, puedes saltarte este paso.',
            ],
        }),

        email: {
            time: 'Unos 15 minutos',
            title: 'Protege tu correo antes que cualquier otra cosa',
            whatHappened: 'A tu cuenta de correo en particular no le ha pasado nada. Este paso está en la lista porque tu correo es lo que protege todo lo demás.',
            whyItMatters: 'Piensa en tu correo como la llave de repuesto de toda tu vida. Si alguien entra ahí, puede ir a tu banco, a tus compras, a lo que sea, y hacer clic en "olvidé mi contraseña". El enlace para cambiarla llega a tu correo, que esa persona está leyendo. Así entra a todas partes.',
            steps: [
                'Ponle a tu correo una contraseña que no uses en ningún otro sitio.',
                'Activa el segundo paso para entrar. Esto quiere decir que, después de escribir tu contraseña, el sitio también manda un código corto a tu teléfono. Aunque un delincuente sepa tu contraseña, no puede entrar sin tener tu teléfono en la mano.',
                'Si usas Gmail: entra a myaccount.google.com, haz clic en "Seguridad" a la izquierda, busca "Verificación en dos pasos" y sigue las instrucciones.',
                'Si usas Outlook o Hotmail: entra a account.microsoft.com, haz clic en "Seguridad" y luego en "Verificación en dos pasos".',
                'Ya que estás en la configuración de tu correo, busca "Reenvío". Asegúrate de que tu correo no se esté copiando a una dirección que no reconoces. Quien entra a un correo suele dejar esto puesto para seguir leyéndolo aunque cambies la contraseña.',
                'Revisa también el teléfono y el correo de "recuperación" que aparecen ahí, y confirma que los dos son tuyos.',
            ],
        },

        securityQs: (n, sites) => ({
            time: 'Unos 10 minutos',
            title: 'Cambia tus preguntas de seguridad',
            whatHappened: `${n === 1 ? 'Un sitio perdió' : `${n} sitios perdieron`} las respuestas a tus preguntas de seguridad. Son esas preguntas como "cuál es el apellido de soltera de tu madre" o "cómo se llamaba tu primera mascota". ${n === 1 ? 'El sitio fue' : 'Los sitios fueron'} ${sites}.`,
            whyItMatters: 'Cambiar la contraseña no sirve de nada si alguien puede hacer clic en "olvidé mi contraseña" y responder esas preguntas correctamente. Ya tiene tus respuestas.',
            steps: [
                'En tus cuentas importantes, entra a la configuración de seguridad y cambia las respuestas de esas preguntas.',
                'No pongas la respuesta verdadera. Inventa otra. Para "primera mascota" puedes responder cortina azul. Nadie lo va a adivinar nunca, porque no es cierto.',
                'Anota tus respuestas inventadas y guarda el papel en un lugar seguro. En una gaveta de tu casa está perfecto.',
            ],
        }),

        identity: (n, sites) => ({
            time: 'Unos 30 minutos',
            title: 'Evita que abran cuentas a tu nombre',
            whatHappened: `${n === 1 ? 'Una de las filtraciones incluyó' : `${n} de las filtraciones incluyeron`} tu número de identidad, como la cédula, el número de seguridad social o el pasaporte. ${n === 1 ? 'Fue' : 'Fueron'} ${sites}.`,
            whyItMatters: 'Una contraseña la cambias cuando quieras. Tu número de identidad no. Alguien podría usarlo, junto con tu nombre y tu dirección, para sacar una tarjeta de crédito o pedir un préstamo haciéndose pasar por ti.',
            steps: [
                'Contacta a las centrales de riesgo o burós de crédito de tu país y pide un bloqueo de crédito. En algunos países lo llaman congelamiento o bloqueo de seguridad.',
                'Es gratis, y puedes hacerlo por teléfono o en su sitio web.',
                'Un bloqueo quiere decir que nadie puede abrir una cuenta nueva a tu nombre. Ni un delincuente, ni tú tampoco, hasta que lo levantes.',
                'No afecta las tarjetas ni las cuentas que ya tienes, y no daña tu puntaje de crédito.',
                'Si más adelante necesitas un préstamo o una tarjeta nueva, puedes levantar el bloqueo unos días y volver a ponerlo.',
                'Abre todas las cartas sobre cuentas que no abriste, en vez de suponer que son publicidad. Esa carta suele ser la primera señal de alarma.',
            ],
        }),

        financial: (n, sites) => ({
            time: 'Unos 20 minutos',
            title: 'Revisa los extractos de tu banco y tus tarjetas',
            whatHappened: `${n === 1 ? 'Una de las filtraciones incluyó' : `${n} de las filtraciones incluyeron`} datos de tarjeta o de banco: ${sites}.`,
            whyItMatters: 'Muchas veces el número de la tarjeta aparece solo en parte, pero junto con tu nombre y tu dirección puede alcanzar para que alguien haga una compra.',
            steps: [
                'Revisa tus últimos tres extractos, línea por línea.',
                'Fíjate en montos pequeños que no reconozcas, aunque sean uno o dos dólares. Los delincuentes prueban una tarjeta robada con una compra mínima primero, y solo gastan de verdad si les funciona.',
                'Si ves algo que no reconoces, por pequeño que sea, llama al número que está en el respaldo de tu tarjeta.',
                'Pídele a tu banco que te mande un mensaje de texto cada vez que se use la tarjeta. Así te enteras de un problema el mismo día y no a fin de mes.',
                'Si usaste una de esas tarjetas en los sitios de arriba y todavía la tienes, pídele al banco que te mande una tarjeta con número nuevo.',
            ],
        }),

        phone: (n) => ({
            time: 'Unos 15 minutos',
            title: 'Protege tu número de teléfono',
            whatHappened: `Tu número de teléfono apareció en ${n === 1 ? 'una de las filtraciones' : `${n} de las filtraciones`}.`,
            whyItMatters: 'Por esto te llegan tantas llamadas y mensajes molestos. Pero hay un riesgo más serio. Alguien puede llamar a tu operador de celular, hacerse pasar por ti y pedir que pasen tu número a un chip nuevo que esa persona tiene. Si lo logra, los códigos de seguridad que tu banco manda por mensaje le llegan a esa persona y no a ti.',
            steps: [
                'Llama a tu operador de celular. Pide que le pongan un PIN o una clave a tu cuenta, para que nadie pueda pasar tu número a otro chip sin eso.',
                'Si te sirve, di estas palabras: "Quiero poner una clave para portabilidad en mi línea." Ellos van a entender.',
                'Si te llaman o te escriben diciendo que son de tu banco, cuelga. Después llama tú al número que está impreso en el respaldo de tu tarjeta. A un banco de verdad nunca le va a molestar que hagas eso.',
                'Nunca le leas un código de seguridad a alguien que te llamó. Esos códigos son para que tú los escribas, jamás para decirlos en voz alta.',
            ],
        }),

        scamsParts: {
            address: (n, total) => total === 1 ? 'tu dirección' : `tu dirección en ${n === 1 ? 'una de ellas' : `${n} de ellas`}`,
            dob: (n, total) => total === 1 ? 'tu fecha de nacimiento' : `tu fecha de nacimiento en ${n === 1 ? 'una' : n}`,
        },
        scamsJoin: ' y ',
        scams: (parts, total) => ({
            time: 'Nada que instalar, solo vale la pena leerlo',
            title: 'Van a llegarte estafas que suenan muy convincentes',
            whatHappened: `${total === 1 ? 'La filtración incluyó' : 'Las filtraciones incluyeron'} ${parts}.`,
            whyItMatters: 'Esto es lo que hace que las estafas de hoy funcionen tan bien. Una carta, un correo o una llamada que ya sabe tu nombre, tu dirección y tu cumpleaños no se siente como una estafa. Se siente oficial. Ese es justamente el truco.',
            steps: [
                'Cuando un mensaje ya sabe tus datos personales, desconfía más, no menos. Que sepan tus datos ya no prueba nada.',
                'Nunca hagas clic en un enlace de un mensaje sobre alguna de tus cuentas. Ciérralo, y abre tú la aplicación o escribe tú la dirección del sitio.',
                'Si alguien te llama y te pide mover plata, comprar tarjetas de regalo o leerle un código, es una estafa siempre, sin excepción. Cuelga. No estás siendo grosero.',
                'Si un mensaje te hace sentir apurado o asustado, es a propósito. Tómate una hora. Las organizaciones de verdad esperan.',
                'Cuando tengas dudas, llama a alguien de confianza y cuéntale el mensaje antes de hacer nada.',
            ],
        }),

        health: (n, sites) => ({
            time: 'Unos 15 minutos',
            title: 'Mantén un ojo en tus cuentas médicas',
            whatHappened: `${n === 1 ? 'Una de las filtraciones incluyó' : `${n} de las filtraciones incluyeron`} información de salud o de seguros: ${sites}.`,
            whyItMatters: 'Alguien podría usar tus datos para recibir atención médica o para reclamar a tu seguro. Esto tarda mucho más en notarse que la plata que desaparece de una cuenta, y es más difícil de arreglar.',
            steps: [
                'Lee los estados de cuenta que te manda tu seguro de salud, en vez de archivarlos sin abrir.',
                'Busca citas, tratamientos o medicamentos que no hayas tenido.',
                'Llama a tu seguro por cualquier cosa que no reconozcas, aunque parezca menor.',
            ],
        }),

        manager: (total) => ({
            time: 'Unos 20 minutos para dejarlo listo',
            title: 'Deja que tu teléfono recuerde tus contraseñas',
            whatHappened: `Tu correo apareció en ${total === 1 ? 'una filtración' : `${total} filtraciones`} en total. En el futuro van a atacar a más empresas. Nada de eso es culpa tuya y no puedes evitarlo.`,
            whyItMatters: 'Nadie puede recordar una contraseña distinta para cada sitio, así que casi todo el mundo usa la misma una y otra vez. Ese es el problema de fondo: una empresa pierde tu contraseña y, de repente, todo lo demás que tienes se abre con ella. Algo que recuerde tus contraseñas por ti resuelve esto por completo.',
            steps: [
                'Lo más probable es que ya lo tengas. Tu teléfono y tu navegador pueden recordar contraseñas por ti.',
                'La próxima vez que un sitio te pregunte "¿Quieres guardar esta contraseña?", di que sí.',
                'Cuando te ofrezca inventar una contraseña, déjalo. No importa que se vea como un disparate, porque nunca vas a tener que escribirla.',
                'Solo necesitas recordar una contraseña: la que abre tu teléfono o tu navegador.',
                'Haz esa larga, y no la uses en ningún otro lado. Tres palabras normales pegadas funcionan muy bien.',
                'Empieza por tu correo y tu banco. No tienes que arreglar todas las cuentas hoy. Unas pocas por semana ya es muy buen avance.',
            ],
        }),
    },
};

function siteNameFor(b, text) {
    return b.title || b.name || text.unnamed;
}

function listSites(breaches, text, max = 4) {
    const names = breaches.slice(0, max).map(b => siteNameFor(b, text));
    const extra = breaches.length - names.length;
    return names.join(', ') + (extra > 0 ? text.andMore(extra) : '');
}

function buildRemediationPlan(breaches, lang = 'en') {
    const text = PLAN_TEXT[pickLang(lang)];
    const all = Array.isArray(breaches) ? breaches : [];

    const stealerLogs = all.filter(b => b.isStealerLog);
    const withPasswords = all.filter(b => hasClass(b, 'passwords'));
    const recentPasswords = withPasswords
        .filter(b => { const m = monthsAgo(b.breachDate); return m !== null && m <= 24; })
        .sort((a, b) => (b.breachDate || '').localeCompare(a.breachDate || ''));
    const withSecurityQs = all.filter(b => hasClass(b, 'security'));
    const withFinancial = all.filter(b => hasClass(b, 'financial'));
    const withIdentity = all.filter(b => hasClass(b, 'identity'));
    const withPhone = all.filter(b => hasClass(b, 'phone'));
    const withAddress = all.filter(b => hasClass(b, 'address'));
    const withDob = all.filter(b => hasClass(b, 'dob'));
    const withHealth = all.filter(b => hasClass(b, 'health'));

    const actions = [];

    if (stealerLogs.length) {
        actions.push({ priority: 'critical', ...text.stealer });
    }

    if (recentPasswords.length) {
        actions.push({
            priority: 'critical',
            ...text.recentPasswords(
                recentPasswords.length,
                listSites(recentPasswords, text),
                listSites(recentPasswords, text, 3)
            ),
        });
    } else if (withPasswords.length) {
        actions.push({
            priority: 'high',
            ...text.oldPasswords(withPasswords.length, listSites(withPasswords, text, 4)),
        });
    }

    actions.push({
        priority: withPasswords.length ? 'critical' : 'high',
        ...text.email,
    });

    if (withSecurityQs.length) {
        actions.push({
            priority: 'high',
            ...text.securityQs(withSecurityQs.length, listSites(withSecurityQs, text)),
        });
    }

    if (withIdentity.length) {
        actions.push({
            priority: 'critical',
            ...text.identity(withIdentity.length, listSites(withIdentity, text)),
        });
    }

    if (withFinancial.length) {
        actions.push({
            priority: 'high',
            ...text.financial(withFinancial.length, listSites(withFinancial, text)),
        });
    }

    if (withPhone.length) {
        actions.push({ priority: 'medium', ...text.phone(withPhone.length) });
    }

    if (withAddress.length || withDob.length) {
        const parts = [];
        if (withAddress.length) parts.push(text.scamsParts.address(withAddress.length, all.length));
        if (withDob.length) parts.push(text.scamsParts.dob(withDob.length, all.length));
        actions.push({ priority: 'medium', ...text.scams(parts.join(text.scamsJoin), all.length) });
    }

    if (withHealth.length) {
        actions.push({
            priority: 'medium',
            ...text.health(withHealth.length, listSites(withHealth, text)),
        });
    }

    actions.push({ priority: 'high', ...text.manager(all.length) });

    const order = { critical: 0, high: 1, medium: 2 };
    actions.sort((a, b) => order[a.priority] - order[b.priority]);

    return {
        actions,
        stats: {
            total: all.length,
            withPasswords: withPasswords.length,
            recentPasswords: recentPasswords.length,
            stealerLogs: stealerLogs.length,
            withIdentity: withIdentity.length,
            withFinancial: withFinancial.length,
            withPhone: withPhone.length,
        },
    };
}

// The unpaid view: the first action in full so the quality is visible, then
// titles only. The steps for everything else never leave the server.
function toTeaser(plan) {
    const [first, ...rest] = plan.actions;
    return {
        entitled: false,
        stats: plan.stats,
        totalActions: plan.actions.length,
        criticalCount: plan.actions.filter(a => a.priority === 'critical').length,
        preview: first || null,
        locked: rest.map(a => ({ title: a.title, priority: a.priority, time: a.time })),
    };
}

// ---------------------------------------------------------------------------

export default async function handler(req, res) {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;

    if (!isAllowedOrigin(origin, host)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (rateLimited(clientIp(req))) {
        res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_MS / 1000));
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;

    // Echoed back on every response so the page can tell a cached plan apart
    // from one written in the language now selected.
    const lang = pickLang(body?.lang);

    // Preview mode: fixed fictional data, always returned in full. No email is
    // read and no breach lookup happens, so this can never leak a real result.
    if (body?.demo === true) {
        const plan = buildRemediationPlan(DEMO_BREACHES, lang);

        // demoTeaser lets the unpaid view be inspected without signing in and
        // running a real check, so the sales page can be reviewed directly.
        if (body.teaser === true) {
            return res.status(200).json({ demo: true, lang, found: true, email: 'sample.person@example.com', ...toTeaser(plan) });
        }

        return res.status(200).json({
            entitled: true,
            demo: true,
            lang,
            email: 'sample.person@example.com',
            breaches: DEMO_BREACHES,
            ...plan,
        });
    }

    const email = body?.email;
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'A valid email is required' });
    }

    const user = await userFromToken(body?.accessToken);
    const entitled = user ? await hasActiveAccess(user.id) : false;

    let breaches;
    try {
        breaches = await fetchBreaches(email);
    } catch (error) {
        if (error.code === 'CONFIG') return res.status(500).json({ error: 'Service not configured' });
        if (error.code === 'RATE') return res.status(429).json({ error: 'Rate limited. Please try again later.' });
        console.error('Breach lookup failed:', error.message);
        return res.status(502).json({ error: 'Could not check that address right now' });
    }

    if (!breaches.length) {
        return res.status(200).json({ entitled, lang, found: false, actions: [], stats: { total: 0 } });
    }

    const plan = buildRemediationPlan(breaches, lang);

    if (!entitled) {
        return res.status(200).json({ found: true, lang, email, ...toTeaser(plan) });
    }

    return res.status(200).json({
        entitled: true,
        found: true,
        lang,
        email,
        breaches,
        ...plan,
    });
}
