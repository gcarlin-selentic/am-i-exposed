// Vercel serverless function: /api/report
//
// Builds the personalised action plan on the server. This is deliberately not
// done in the browser: the plan is the paid product, so the full text must
// never be sent to someone who has not bought it. Unpaid callers get a teaser
// (the first action in full, plus the titles of the rest) and nothing more.

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

const siteName = b => b.title || b.name || 'an unnamed breach';

function listSites(breaches, max = 4) {
    const names = breaches.slice(0, max).map(siteName);
    const extra = breaches.length - names.length;
    return names.join(', ') + (extra > 0 ? `, and ${extra} more` : '');
}

function buildRemediationPlan(breaches) {
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
        actions.push({
            priority: 'critical',
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
        });
    }

    if (recentPasswords.length) {
        actions.push({
            priority: 'critical',
            time: 'About 5 minutes for each website',
            title: 'Change your password on these websites',
            whatHappened: `${recentPasswords.length} website${recentPasswords.length > 1 ? 's were' : ' was'} broken into in the last two years, and your password was taken: ${listSites(recentPasswords)}.`,
            whyItMatters: 'These lists get bought and sold. Criminals take your email address and that password, then try the pair on other websites, such as your bank or your email, hoping you used the same one twice.',
            steps: [
                `Go to each of these websites and change your password: ${listSites(recentPasswords, 3)}.`,
                'Usually you find this under "Settings", then "Password" or "Security". If you cannot find it, search the website for the words "change password".',
                'Give each website a different password. Never the same one twice.',
                'Now the important part: if you used that same password anywhere else, change it there too. Especially your email and your bank.',
                'A good password is three ordinary words joined together, like purple-tractor-window. Long is better than complicated. You do not need symbols and capital letters to be safe.',
            ],
        });
    } else if (withPasswords.length) {
        actions.push({
            priority: 'high',
            time: 'About 5 minutes for each website',
            title: 'Change any old password you still use',
            whatHappened: `${withPasswords.length} of the websites you were on lost passwords, though none of them recently. They were ${listSites(withPasswords, 4)}.`,
            whyItMatters: 'Old lists never go away. If you are still using one of those passwords somewhere today, it is still a risk. If you stopped using it years ago, you can relax about this one.',
            steps: [
                'Think about whether you still use any of those old passwords anywhere.',
                'If you do, change it on those accounts. Start with your email and your bank.',
                'If you have not used those passwords in years, you can skip this step.',
            ],
        });
    }

    actions.push({
        priority: withPasswords.length ? 'critical' : 'high',
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
    });

    if (withSecurityQs.length) {
        actions.push({
            priority: 'high',
            time: 'About 10 minutes',
            title: 'Change your security questions',
            whatHappened: `${withSecurityQs.length} website${withSecurityQs.length > 1 ? 's' : ''} lost the answers to your security questions. These are the questions like "what was your mother's maiden name" or "what was the name of your first pet". The website was ${listSites(withSecurityQs)}.`,
            whyItMatters: 'Changing your password does not help if somebody can simply click "forgot my password" and then answer those questions correctly. They already have your answers.',
            steps: [
                'On your important accounts, go into the security settings and change the answers to these questions.',
                'Do not put the true answer. Make something up instead. For "first pet" you could answer blue curtain. Nobody will ever guess that, because it is not true.',
                'Write your made-up answers down and keep the note somewhere safe. On paper in a drawer at home is perfectly fine.',
            ],
        });
    }

    if (withIdentity.length) {
        actions.push({
            priority: 'critical',
            time: 'About 30 minutes',
            title: 'Stop anyone opening accounts in your name',
            whatHappened: `${withIdentity.length} of the break-ins included your identity number, such as a national ID, social security or passport number. ${withIdentity.length > 1 ? 'They were' : 'It was'} ${listSites(withIdentity)}.`,
            whyItMatters: 'You can change a password whenever you like. You cannot change your ID number. Somebody could use it, along with your name and address, to open a credit card or take out a loan pretending to be you.',
            steps: [
                'Contact the credit agencies in your country and ask for a credit freeze. Some countries call it a security freeze or a credit lock.',
                'It is free, and you can do it by phone or on their website.',
                'A freeze means nobody can open a new account in your name. Not a criminal, and not you either, until you lift it.',
                'It does not affect the cards and accounts you already have, and it does not harm your credit score.',
                'If you need a loan or a new card later, you can lift the freeze for a few days and then put it back.',
                'Open every letter about an account you did not open, rather than assuming it is junk mail. That letter is usually the first warning sign.',
            ],
        });
    }

    if (withFinancial.length) {
        actions.push({
            priority: 'high',
            time: 'About 20 minutes',
            title: 'Check your bank and card statements',
            whatHappened: `${withFinancial.length} of the break-ins included card or bank details: ${listSites(withFinancial)}.`,
            whyItMatters: 'Card numbers are often only partly included, but combined with your name and address that can be enough for somebody to make a purchase.',
            steps: [
                'Look through your last three statements, line by line.',
                'Pay attention to small amounts you do not recognise, even one or two pounds or dollars. Criminals test a stolen card with a tiny purchase first, and only spend properly if it works.',
                'If you see anything you do not recognise, however small, phone the number on the back of your card.',
                'Ask your bank to send you a text message every time the card is used. Then you hear about a problem the same day instead of at the end of the month.',
                'If you used one of those cards on the websites above and still have it, ask the bank to send you a new card number.',
            ],
        });
    }

    if (withPhone.length) {
        actions.push({
            priority: 'medium',
            time: 'About 15 minutes',
            title: 'Protect your phone number',
            whatHappened: `Your phone number was included in ${withPhone.length} of the break-ins.`,
            whyItMatters: 'This is why you get so many nuisance calls and texts. There is a more serious risk as well. Someone can telephone your mobile company, pretend to be you, and ask them to move your number onto a new SIM card in their possession. If they manage it, the security codes your bank sends by text go to them instead of you.',
            steps: [
                'Phone your mobile company. Ask them to put a PIN or a password on your account, so that nobody can move your number to another SIM without it.',
                'Say these exact words if it helps: "Please add a port-out PIN to my account." They will know what you mean.',
                'If a call or a text claims to be from your bank, hang up. Then telephone the number printed on the back of your card. A real bank will never mind you doing this.',
                'Never read a security code out to somebody who telephones you. Those codes are for you to type in, never to say out loud.',
            ],
        });
    }

    if (withAddress.length || withDob.length) {
        const parts = [];
        if (withAddress.length) parts.push(`your home address in ${withAddress.length} of them`);
        if (withDob.length) parts.push(`your date of birth in ${withDob.length}`);
        actions.push({
            priority: 'medium',
            time: 'Nothing to install, just worth reading',
            title: 'Expect scams that sound very convincing',
            whatHappened: `The break-ins included ${parts.join(' and ')}.`,
            whyItMatters: 'This is what makes modern scams work so well. A letter, email or phone call that already knows your name, your address and your birthday does not feel like a scam. It feels official. That is exactly the trick.',
            steps: [
                'When a message already knows your personal details, treat it as more suspicious, not less. Knowing your details proves nothing any more.',
                'Never click a link in a message about one of your accounts. Close it, and open the app or type the website address in yourself.',
                'If somebody telephones and asks you to move money, buy gift cards, or read out a code, it is a scam every single time. Put the phone down. You are not being rude.',
                'If a message makes you feel rushed or frightened, that is deliberate. Take an hour. Real organisations will wait.',
                'When in doubt, telephone somebody you trust and describe the message to them before you do anything.',
            ],
        });
    }

    if (withHealth.length) {
        actions.push({
            priority: 'medium',
            time: 'About 15 minutes',
            title: 'Keep an eye on your medical bills',
            whatHappened: `${withHealth.length} of the break-ins included health or insurance information: ${listSites(withHealth)}.`,
            whyItMatters: 'Somebody could use your details to get treatment or claim on your insurance. This takes much longer to notice than money going missing from a bank account, and it is more difficult to put right.',
            steps: [
                'Read the statements your health insurer sends you instead of filing them away unopened.',
                'Look for appointments, treatments or prescriptions you did not have.',
                'Telephone your insurer about anything you do not recognise, even if it seems minor.',
            ],
        });
    }

    actions.push({
        priority: 'high',
        time: 'About 20 minutes to set up',
        title: 'Let your phone remember your passwords for you',
        whatHappened: `Your email address turned up in ${all.length} break-in${all.length > 1 ? 's' : ''} in total. More companies will be broken into in future. None of that is your fault and you cannot prevent it.`,
        whyItMatters: 'Nobody can remember a different password for every website, so most people use the same one over and over. That is the real problem: one company loses your password, and suddenly everything else you own is unlocked with it. Something that remembers your passwords for you fixes this completely.',
        steps: [
            'You very likely already have one. Your phone and your web browser can both remember passwords for you.',
            'Next time a website asks "Would you like to save this password?", say yes.',
            'When it offers to make up a password for you, let it. It does not matter that the password looks like nonsense, because you will never have to type it.',
            'You only need to remember one password: the one that unlocks your phone or your browser.',
            'Make that one long, and never use it anywhere else. Three ordinary words joined together works well.',
            'Start with your email and your bank. You do not need to fix every account today. A few each week is perfectly good progress.',
        ],
    });

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

    // Preview mode: fixed fictional data, always returned in full. No email is
    // read and no breach lookup happens, so this can never leak a real result.
    if (body?.demo === true) {
        const plan = buildRemediationPlan(DEMO_BREACHES);

        // demoTeaser lets the unpaid view be inspected without signing in and
        // running a real check, so the sales page can be reviewed directly.
        if (body.teaser === true) {
            return res.status(200).json({ demo: true, found: true, ...toTeaser(plan) });
        }

        return res.status(200).json({
            entitled: true,
            demo: true,
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
        return res.status(200).json({ entitled, found: false, actions: [], stats: { total: 0 } });
    }

    const plan = buildRemediationPlan(breaches);

    if (!entitled) {
        return res.status(200).json({ found: true, ...toTeaser(plan) });
    }

    return res.status(200).json({
        entitled: true,
        found: true,
        email,
        breaches,
        ...plan,
    });
}
