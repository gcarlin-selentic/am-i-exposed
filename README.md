# Am I Exposed? — Breach Checker

Free and paid breach exposure checking tool for Selentic Group.

## Setup

### Environment Variables

Create a `.env` file (or `.env.local` for Vercel):

```
HIBP_API_KEY=your_hibp_api_key_here
```

**HIBP Setup:**
- Sign up at https://haveibeenpwned.com/API/v3
- Use **Core 1 plan** ($4.39/mo) — this is for individual self-checks, not third-party domain checks
- Copy your API key into `.env`

### Running Locally

For free tier testing (no HIBP key needed):
```bash
npm install
npm run dev
```

Password checks work client-side via k-anonymity API (no key required).
Email checks will fail without `HIBP_API_KEY` set.

### Deploying to Vercel

1. `vercel` to deploy
2. Set `HIBP_API_KEY` in Vercel project settings → Environment Variables
3. Deploy again

## Tier Structure

### Free Tier (Live)
- ✓ Email breach check (requires HIBP API key)
- ✓ Password breach check (client-side, no key needed)
- No results storage
- No account required

### Paid Tier (Coming Soon)
- Full breach report
- Dark web monitoring
- PDF delivery via email
- Mercado Pago payment integration

## API Endpoints

### `GET /api/check-email?email=user@example.com`

Proxies HIBP's breach search. Returns breach names and dates.

**Response:**
```json
{
  "breaches": [
    {
      "name": "LinkedIn",
      "breachDate": "2021-06-01",
      "dataClasses": ["Email addresses", "Names", "Phone numbers"]
    }
  ],
  "found": true
}
```

**Error:**
```json
{
  "error": "Email not found in breaches",
  "found": false
}
```

## Design System

- **Colors:** Navy (#1C2B3A), Off-white (#F9F7F4), Green (#10B981), Amber (#F59E0B), Red (#EF4444)
- **Fonts:** Inter (body), Source Serif 4 (headlines)
- **Results:** Traffic-light colors (green = safe, amber = caution, red = exposed)

## Notes

- **No credit card collection** — never add this, even as a stub
- **No password storage** — password checks must stay client-side
- **No credential stuffing** — never attempt login verification with exposed credentials
- **All API keys server-side** — never expose HIBP key to client
