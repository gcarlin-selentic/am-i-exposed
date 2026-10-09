// Vercel serverless function: /api/alerts-config
//
// Answers one question: may this visitor be offered the alert subscription,
// and with what. Called once, lazily, the first time somebody runs a check,
// so a visitor who never searches never costs an invocation.
//
// The country decides, and the country never travels back. The response says
// eligible true or false and nothing else about location. Telling a browser
// "we think you are in Peru" is a fact about the visitor we have no reason to
// hand them, and it would be the one piece of this that a screenshot could
// turn into a complaint.
//
// Eligibility is United States only, which is the whole design: the alerts
// are about United States class action settlements, the subscription is
// priced in dollars through Paddle, and the privacy notice that covers it is
// written for United States law. Offering it anywhere else would be selling
// something that cannot pay out.

// Vercel sets this on every request from its edge. It is not a header a
// browser can forge: Vercel overwrites whatever arrives with its own value.
const COUNTRY_HEADER = 'x-vercel-ip-country';

// Paddle's client-side tokens are prefixed test_ in sandbox and live_ in
// production. Reading the environment off the token means the two can never
// disagree: there is no second setting to forget to change on the day this
// goes live.
function environmentFor(token) {
    return token.startsWith('test_') ? 'sandbox' : 'production';
}

export default function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Per visitor, so one person's country is never served to another from a
    // shared cache. Vercel caches /api/* for zero seconds already, and this
    // says so explicitly rather than relying on that staying true.
    res.setHeader('Cache-Control', 'private, no-store');

    const country = req.headers[COUNTRY_HEADER];
    if (country !== 'US') {
        return res.status(200).json({ eligible: false });
    }

    const token = process.env.PADDLE_CLIENT_TOKEN;
    const priceId = process.env.PADDLE_PRICE_ID;

    // Eligible by country but not configured yet. Answered as not eligible
    // rather than as an error: a visitor should see no card at all, not a
    // card that fails when they click it.
    if (!token || !priceId) {
        console.error('Alerts not configured:',
            { token: !!token, priceId: !!priceId });
        return res.status(200).json({ eligible: false });
    }

    return res.status(200).json({
        eligible: true,
        token,
        priceId,
        environment: environmentFor(token),
    });
}
