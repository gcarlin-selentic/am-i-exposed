import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isClaimableBreach, selectForSubscriber, settlementId, toAlertItem, buildAlertEmail,
} from './_settlement-alerts.mjs';

const OPEN = {
    empresa: 'Baptist Health', pago_texto: '$4,480', plazo: '2026-12-08',
    sitio_reclamo: 'bhsettlement.com', filtracion: true, cubre: 'Notice of the breach.',
};

test('closed window is not claimable', () => {
    assert.equal(isClaimableBreach({ ...OPEN, plazo: '2020-01-01' }, '2026-11-01'), false);
});

test('open data-breach window is claimable', () => {
    assert.equal(isClaimableBreach(OPEN, '2026-11-01'), true);
});

test('non-breach row is not claimable', () => {
    assert.equal(isClaimableBreach({ ...OPEN, filtracion: false }, '2026-11-01'), false);
});

test('hyundai/kia car-theft is excluded', () => {
    assert.equal(isClaimableBreach({ ...OPEN, empresa: 'Hyundai, Kia' }, '2026-11-01'), false);
});

test('toAlertItem keeps the published amount verbatim, never computes it', () => {
    const item = toAlertItem(OPEN);
    assert.equal(item.amount, '$4,480');
    assert.equal(item.company, 'Baptist Health');
    assert.equal(item.deadlineISO, '2026-12-08');
    assert.equal(item.site, 'bhsettlement.com');
});

test('new subscriber gets a welcome with all open items', () => {
    const r = selectForSubscriber([OPEN], [], '2026-11-01');
    assert.equal(r.welcome, true);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].amount, '$4,480');
});

test('already-alerted settlement is not re-sent', () => {
    const r = selectForSubscriber([OPEN], [settlementId(OPEN)], '2026-11-01');
    assert.equal(r.welcome, false);
    assert.equal(r.items.length, 0);
});

test('alert email keeps amounts verbatim, links the official site, makes no promise, and can unsubscribe', () => {
    const items = [toAlertItem(OPEN)];
    const { subject, html } = buildAlertEmail({
        items, welcome: true, lang: 'en',
        unsubscribeUrl: 'https://www.am-i-exposed.com/api/unsubscribe?token=abc',
    });
    assert.match(subject, /open|claim/i);
    assert.ok(html.includes('Baptist Health'));
    assert.ok(html.includes('$4,480'));
    assert.ok(html.includes('bhsettlement.com'));
    assert.ok(/may be able to claim/i.test(html));
    assert.ok(!/guarantee|you are owed|you will (get|receive)/i.test(html));
    assert.ok(html.includes('/api/unsubscribe?token=abc'));
});
