import { handleSignup } from './_monitor-signup.mjs';
import { handleConfirm } from './_confirm.mjs';
import { handleUnsubscribe } from './_unsubscribe.mjs';
import { handleRun } from './_run-alerts.mjs';
import { handleConfig } from './_alerts-config.mjs';

// maxDuration covers the op=run breach job (paced HIBP lookups); harmless to the fast ops.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
    const op = req.query?.op;
    switch (op) {
        case 'signup':      return handleSignup(req, res);
        case 'confirm':     return handleConfirm(req, res);
        case 'unsubscribe': return handleUnsubscribe(req, res);
        case 'run':         return handleRun(req, res);
        case 'config':      return handleConfig(req, res);
        default:            return res.status(404).json({ error: 'Not found' });
    }
}
