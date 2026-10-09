// Vercel serverless function: /api/paddle-webhook-sandbox
//
// Sandbox Paddle events only. Everything it writes carries live_mode false, so
// a test subscription can never be mistaken for a paying one, and it verifies
// against a different secret than the live endpoint.
//
// It runs on the production deployment on purpose: that is the only stable
// public URL the site has, and a Vercel preview URL changes on every push,
// which would mean re-pointing the Paddle destination constantly. Living on
// the same host is safe precisely because it is a separate path with a
// separate secret writing separate rows.

import { paddleWebhookHandler } from './_paddle.js';

// Paddle signs the bytes it sent. Vercel parses a JSON body by default and the
// raw bytes are then gone, so the signature can never be reproduced.
export const config = { api: { bodyParser: false } };

export default paddleWebhookHandler({
    secretEnv: 'PADDLE_WEBHOOK_SECRET_SANDBOX',
    liveMode: false,
});
