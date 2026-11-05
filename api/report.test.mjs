// Tests for the Claim Pack matching in report.js. Pure functions only: each
// takes its rows explicitly so the test does not depend on the live JSON data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPersonalSettlements, openPool, buildClaimPack, toClaimsTeaser } from './report.js';

const SETTLEMENT_ROWS = [
    { hibp: 'Yahoo', empresa: 'Yahoo', slug: 'yahoo', porPersona: 25000, plazo: '2020-07-20', sitio: 'YahooDataBreachSettlement.com', elegible: 'Yahoo users 2012-2016.' },
    { hibp: 'Experian', empresa: 'Experian', slug: 'experian', porPersona: 10000, plazo: '2019-04-11', sitio: 'ExpDataBreachSettlement.com', elegible: 'Experian notice Oct 2015.' },
    { hibp: 'Comcast', empresa: 'Comcast', slug: 'comcast', porPersona: 10000, plazo: '2099-09-14', sitio: 'ComcastBreachSettlement.com', elegible: 'Comcast notice 2023.' },
    { hibp: 'MGM', empresa: 'MGM Resorts', slug: 'mgm', porPersona: null, plazo: null, sitio: null, elegible: null },
];

const OPEN_ROWS = [
    { empresa: 'Lands’ End', filtracion: true, plazo: '2099-10-22', pago_texto: '$60 - $5,000', sitio_reclamo: 'landsenddatasettlement.com', cubre: 'Dec 2024 breach.', comprobante: 'no' },
    { empresa: 'AMN Healthcare', filtracion: true, plazo: '2099-10-27', pago_texto: 'TBD', sitio_reclamo: 'amncipasettlement.com', cubre: 'California.', comprobante: 'no' },
    { empresa: 'Old Closed Co', filtracion: true, plazo: '2000-01-01', pago_texto: '$10', sitio_reclamo: 'x.com', cubre: 'x', comprobante: 'no' },
    { empresa: 'Not A Breach', filtracion: false, plazo: '2099-01-01', pago_texto: '$10', sitio_reclamo: 'y.com', cubre: 'y', comprobante: 'no' },
];

test('matchPersonalSettlements matches breaches by hibp name', () => {
    const breaches = [{ name: 'Yahoo' }, { name: 'Experian' }, { name: 'UnrelatedSite' }];
    const { items, totalMax, openCount } = matchPersonalSettlements(breaches, '2026-11-04', SETTLEMENT_ROWS);
    assert.equal(items.length, 2);
    assert.equal(totalMax, 35000);
    assert.equal(openCount, 0);
    assert.deepEqual(items.map(i => i.empresa).sort(), ['Experian', 'Yahoo']);
    assert.ok(items.every(i => i.status === 'closed'));
});

test('matchPersonalSettlements flags a still-open match and sorts it first', () => {
    const breaches = [{ name: 'Yahoo' }, { name: 'Comcast' }];
    const { items, openCount } = matchPersonalSettlements(breaches, '2026-11-04', SETTLEMENT_ROWS);
    assert.equal(openCount, 1);
    assert.equal(items[0].empresa, 'Comcast');
    assert.equal(items[0].status, 'open');
});

test('matchPersonalSettlements returns nothing when no breach matches', () => {
    const { items, totalMax, openCount } = matchPersonalSettlements([{ name: 'NoSuch' }], '2026-11-04', SETTLEMENT_ROWS);
    assert.equal(items.length, 0);
    assert.equal(totalMax, 0);
    assert.equal(openCount, 0);
});

test('matchPersonalSettlements dedupes repeated breach names', () => {
    const breaches = [{ name: 'Yahoo' }, { name: 'Yahoo' }];
    const { items } = matchPersonalSettlements(breaches, '2026-11-04', SETTLEMENT_ROWS);
    assert.equal(items.length, 1);
});

test('openPool returns only currently-open breach settlements, soonest first', () => {
    const pool = openPool('2026-11-04', OPEN_ROWS);
    assert.equal(pool.length, 2);
    assert.deepEqual(pool.map(p => p.empresa), ['Lands’ End', 'AMN Healthcare']);
    assert.equal(pool[0].pagoTexto, '$60 - $5,000');
    assert.equal(pool[0].comprobante, 'no');
    assert.equal(pool[0].sitio, 'landsenddatasettlement.com');
});

test('buildClaimPack carries personal matches, the open pool and the filing guide', () => {
    const breaches = [{ name: 'Yahoo' }, { name: 'Comcast' }];
    const pack = buildClaimPack(breaches, 'en', '2026-11-04', SETTLEMENT_ROWS, OPEN_ROWS);
    assert.equal(pack.personal.length, 2);
    assert.equal(pack.personalOpenCount, 1);
    assert.equal(pack.open.length, 2);
    assert.equal(pack.openCount, 2);
    assert.ok(pack.guide && typeof pack.guide.title === 'string');
    assert.ok(Array.isArray(pack.guide.steps) && pack.guide.steps.length >= 4);
});

test('buildClaimPack writes the guide in the requested language', () => {
    const en = buildClaimPack([{ name: 'Yahoo' }], 'en', '2026-11-04', SETTLEMENT_ROWS, OPEN_ROWS);
    const es = buildClaimPack([{ name: 'Yahoo' }], 'es', '2026-11-04', SETTLEMENT_ROWS, OPEN_ROWS);
    assert.notEqual(en.guide.title, es.guide.title);
});

test('toClaimsTeaser keeps the exposure history but strips the paid guide and open detail', () => {
    const pack = buildClaimPack([{ name: 'Yahoo' }, { name: 'Comcast' }], 'en', '2026-11-04', SETTLEMENT_ROWS, OPEN_ROWS);
    const teaser = toClaimsTeaser(pack);
    assert.equal(teaser.personal.length, 2);
    assert.equal(teaser.personalTotalMax, 35000);
    assert.equal(teaser.openCount, 2);
    assert.equal(teaser.guide, undefined);
    assert.equal(teaser.open, undefined);
});
