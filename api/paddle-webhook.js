// Vercel serverless function: /api/paddle-webhook
//
// Live Paddle events only. Its sandbox twin is paddle-webhook-sandbox.js, and
// the two share everything except two things that must never be shared: the
// secret that verifies the signature, and whether the rows written are live.
//
// Both live here rather than in one endpoint because this is what decides who
// is subscribed. One endpoint distinguishing the environments by which secret
// happened to verify would mean a configuration slip hands out real alerts for
// a sandbox test card. Two files cannot make that mistake.

import { paddleWebhookHandler } from './_paddle.js';

// Paddle signs the bytes it sent. Vercel parses a JSON body by default and the
// raw bytes are then gone, so the signature can never be reproduced. This is
// not optional.
export const config = { api: { bodyParser: false } };

export default paddleWebhookHandler({
    secretEnv: 'PADDLE_WEBHOOK_SECRET',
    liveMode: true,
});
