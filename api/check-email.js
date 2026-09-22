// Vercel serverless function: /api/check-email
// Proxies to HIBP's breach search API

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { email } = req.query;

    if (!email) {
        return res.status(400).json({ error: 'Email parameter required' });
    }

    // Validate email format
    if (!email.includes('@') || email.length > 254) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    const apiKey = process.env.HIBP_API_KEY;
    if (!apiKey) {
        console.error('HIBP_API_KEY not configured');
        return res.status(500).json({ error: 'Service not configured' });
    }

    try {
        // Call HIBP API
        const response = await fetch(
            `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}`,
            {
                method: 'GET',
                headers: {
                    'User-Agent': 'Am-I-Exposed-Check',
                    'X-Requested-With': 'XMLHttpRequest',
                    'hibp-api-key': apiKey,
                },
            }
        );

        // Email not found in any breaches
        if (response.status === 404) {
            return res.status(200).json({
                found: false,
                email: email,
                message: 'Email not found in breaches',
            });
        }

        // Email found in breaches
        if (response.status === 200) {
            const breaches = await response.json();

            // Sanitize: only return name, breach date, and data classes
            const sanitized = breaches.map(breach => ({
                name: breach.Name,
                breachDate: breach.BreachDate,
                dataClasses: breach.DataClasses || [],
                title: breach.Title || breach.Name,
            }));

            return res.status(200).json({
                found: true,
                email: email,
                breachCount: sanitized.length,
                breaches: sanitized,
            });
        }

        // Rate limited
        if (response.status === 429) {
            return res.status(429).json({ error: 'Rate limited. Please try again later.' });
        }

        // Unexpected error
        return res.status(500).json({ error: 'Failed to check email' });
    } catch (error) {
        console.error('HIBP API error:', error);
        return res.status(500).json({ error: 'Failed to check email' });
    }
}
