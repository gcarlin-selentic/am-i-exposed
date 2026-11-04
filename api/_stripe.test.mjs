import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    parseStripeSig, verifyStripeSignature,
    planSpec, priceIdFor, planFromPriceId, toForm, monitorStatus,
} from './_stripe.mjs';

const SECRET = 'whsec_testsecret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

function sign(body, secret, t) {
    const payload = `${t}.${body}`;
    const v1 = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return { header: `t=${t},v1=${v1}`, v1 };
}

// --- parseStripeSig ---
test('parseStripeSig reads t and one or more v1', () => {
    assert.deepEqual(parseStripeSig('t=123,v1=abc'), { t: '123', v1: ['abc'] });
    const p = parseStripeSig('t=123,v1=abc,v1=def,v0=ignored');
    assert.equal(p.t, '123');
    assert.deepEqual(p.v1, ['abc', 'def']);
});

test('parseStripeSig rejects junk', () => {
    assert.equal(parseStripeSig(''), null);
    assert.equal(parseStripeSig('nope'), null);
    assert.equal(parseStripeSig('v1=abc'), null);      // no t
    assert.equal(parseStripeSig('t=123'), null);       // no v1
    assert.equal(parseStripeSig(null), null);
});

// --- verifyStripeSignature ---
const NOW = 1_800_000_000;

test('a correctly signed body verifies', () => {
    const { header } = sign(BODY, SECRET, NOW);
    assert.equal(verifyStripeSignature(BODY, header, SECRET, { nowSec: NOW }), true);
    // raw body as a Buffer must verify identically
    assert.equal(verifyStripeSignature(Buffer.from(BODY), header, SECRET, { nowSec: NOW }), true);
});

test('a tampered body fails', () => {
    const { header } = sign(BODY, SECRET, NOW);
    assert.equal(verifyStripeSignature(BODY + ' ', header, SECRET, { nowSec: NOW }), false);
});

test('the wrong secret fails', () => {
    const { header } = sign(BODY, SECRET, NOW);
    assert.equal(verifyStripeSignature(BODY, header, 'whsec_wrong', { nowSec: NOW }), false);
});

test('no secret configured fails closed', () => {
    const { header } = sign(BODY, SECRET, NOW);
    assert.equal(verifyStripeSignature(BODY, header, '', { nowSec: NOW }), false);
});

test('a timestamp outside the tolerance is rejected (replay)', () => {
    const { header } = sign(BODY, SECRET, NOW - 10_000);
    assert.equal(verifyStripeSignature(BODY, header, SECRET, { nowSec: NOW, toleranceSec: 300 }), false);
});

test('a timestamp within tolerance passes', () => {
    const { header } = sign(BODY, SECRET, NOW - 120);
    assert.equal(verifyStripeSignature(BODY, header, SECRET, { nowSec: NOW, toleranceSec: 300 }), true);
});

test('any of several v1 signatures matching is a match (secret rotation)', () => {
    const t = NOW;
    const good = crypto.createHmac('sha256', SECRET).update(`${t}.${BODY}`).digest('hex');
    const header = `t=${t},v1=deadbeef,v1=${good}`;
    assert.equal(verifyStripeSignature(BODY, header, SECRET, { nowSec: NOW }), true);
});

// --- plan <-> price mapping ---
const ENV = {
    STRIPE_PRICE_REPORT: 'price_report',
    STRIPE_PRICE_BREACH_MONTH: 'price_bm',
    STRIPE_PRICE_BREACH_YEAR: 'price_by',
    STRIPE_PRICE_SETTLEMENT_MONTH: 'price_sm',
    STRIPE_PRICE_SETTLEMENT_YEAR: 'price_sy',
    STRIPE_PRICE_COMBO_MONTH: 'price_cm',
    STRIPE_PRICE_COMBO_YEAR: 'price_cy',
};

test('planSpec maps the query param to mode/plan/interval', () => {
    assert.deepEqual(planSpec('report'), { env: 'STRIPE_PRICE_REPORT', mode: 'payment', plan: 'report', interval: null });
    assert.deepEqual(planSpec('combo_year'), { env: 'STRIPE_PRICE_COMBO_YEAR', mode: 'subscription', plan: 'combo', interval: 'year' });
    assert.equal(planSpec('nonsense'), null);
    assert.equal(planSpec(''), null);
});

test('priceIdFor resolves the configured price id', () => {
    assert.equal(priceIdFor('report', ENV), 'price_report');
    assert.equal(priceIdFor('combo_month', ENV), 'price_cm');
    assert.equal(priceIdFor('breach_year', ENV), 'price_by');
    assert.equal(priceIdFor('report', {}), null);   // unconfigured
    assert.equal(priceIdFor('bogus', ENV), null);
});

test('planFromPriceId reverses a Stripe price id to its plan', () => {
    assert.deepEqual(planFromPriceId('price_cy', ENV), { mode: 'subscription', plan: 'combo', interval: 'year' });
    assert.deepEqual(planFromPriceId('price_report', ENV), { mode: 'payment', plan: 'report', interval: null });
    assert.equal(planFromPriceId('price_unknown', ENV), null);
});

// --- form encoding for the Stripe REST API ---
test('toForm encodes nested objects and arrays in Stripe bracket notation', () => {
    const body = toForm({
        mode: 'subscription',
        'line_items[0][price]': 'price_cm',
        'line_items[0][quantity]': 1,
        metadata: { plan: 'combo', lang: 'en' },
        tags: ['a', 'b'],
    });
    const params = new URLSearchParams(body);
    assert.equal(params.get('mode'), 'subscription');
    assert.equal(params.get('line_items[0][price]'), 'price_cm');
    assert.equal(params.get('line_items[0][quantity]'), '1');
    assert.equal(params.get('metadata[plan]'), 'combo');
    assert.equal(params.get('metadata[lang]'), 'en');
    assert.equal(params.get('tags[0]'), 'a');
    assert.equal(params.get('tags[1]'), 'b');
});

test('monitorStatus maps Stripe statuses to what the daily jobs read', () => {
    assert.equal(monitorStatus('active'), 'active');
    assert.equal(monitorStatus('trialing'), 'active');
    assert.equal(monitorStatus('past_due'), 'past_due');
    assert.equal(monitorStatus('unpaid'), 'past_due');
    assert.equal(monitorStatus('paused'), 'paused');
    assert.equal(monitorStatus('canceled'), 'canceled');
    assert.equal(monitorStatus('incomplete_expired'), 'canceled');
    assert.equal(monitorStatus('anything_else'), 'canceled');
});

test('toForm skips null and undefined values', () => {
    const params = new URLSearchParams(toForm({ a: 1, b: null, c: undefined, d: '' }));
    assert.equal(params.get('a'), '1');
    assert.equal(params.has('b'), false);
    assert.equal(params.has('c'), false);
    assert.equal(params.get('d'), '');
});
