import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, isValidEmail, newBreaches, mergeKnown, decideAction } from './_breach-watch.mjs';

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  A@B.COM '), 'a@b.com');
});
test('isValidEmail accepts and rejects', () => {
  assert.equal(isValidEmail('a@b.com'), true);
  assert.equal(isValidEmail('nope'), false);
  assert.equal(isValidEmail('a@b'), false);
});
test('newBreaches returns only names not already known, unique, in order', () => {
  assert.deepEqual(newBreaches(['B', 'A', 'B'], ['A']), ['B']);
  assert.deepEqual(newBreaches(['A'], ['A', 'B']), []);
  assert.deepEqual(newBreaches(['C', 'D', 'C'], []), ['C', 'D']);
});
test('mergeKnown is a sorted unique union', () => {
  assert.deepEqual(mergeKnown(['A'], ['C', 'A', 'B']), ['A', 'B', 'C']);
});
test('decideAction: first check is a welcome with the full current exposure', () => {
  assert.deepEqual(decideAction({ baselineDone: false, newNames: ['A'], returnedNames: ['A'] }), { kind: 'welcome', breaches: ['A'] });
  assert.deepEqual(decideAction({ baselineDone: false, newNames: [], returnedNames: [] }), { kind: 'welcome', breaches: [] });
});
test('decideAction: later check alerts only on new names', () => {
  assert.deepEqual(decideAction({ baselineDone: true, newNames: ['C'], returnedNames: ['A', 'C'] }), { kind: 'alert', breaches: ['C'] });
  assert.deepEqual(decideAction({ baselineDone: true, newNames: [], returnedNames: ['A'] }), { kind: 'none' });
});

import { secretMatches, authorizeCron, processSubscribers } from './_breach-watch.mjs';

test('secretMatches is true only on exact match', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abc', 'abd'), false);
  assert.equal(secretMatches('', 'abc'), false);
  assert.equal(secretMatches('ab', 'abc'), false);
});
test('authorizeCron accepts only Bearer <secret>', () => {
  assert.equal(authorizeCron('Bearer s3cret', 's3cret'), true);
  assert.equal(authorizeCron('s3cret', 's3cret'), false);
  assert.equal(authorizeCron('Bearer wrong', 's3cret'), false);
});

function fakes(lookups) {
  const sent = [];
  const patched = [];
  return {
    hibpLookup: async (email) => lookups[email],
    sendWelcome: async (sub, breaches) => { sent.push(['welcome', sub.id, breaches]); return true; },
    sendAlert: async (sub, names) => { sent.push(['alert', sub.id, names]); return true; },
    patch: async (id, fields) => { patched.push([id, fields]); return true; },
    now: () => '2026-11-02T00:00:00Z',
    sent, patched,
  };
}

test('first check sends welcome and sets baseline', async () => {
  const f = fakes({ 'a@b.com': { status: 'clean', names: [] } });
  const counts = await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: [], baseline_done: false }], ...f });
  assert.deepEqual(counts, { checked: 1, welcomed: 1, alerted: 0, errors: 0 });
  assert.equal(f.patched[0][1].baseline_done, true);
});
test('later check alerts only on new breach and unions known', async () => {
  const f = fakes({ 'a@b.com': { status: 'found', names: ['A', 'C'] } });
  await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: ['A'], baseline_done: true }], ...f });
  assert.deepEqual(f.sent[0], ['alert', 1, ['C']]);
  assert.deepEqual(f.patched[0][1].known_breaches, ['A', 'C']);
});
test('no new breach sends nothing, patches only last_checked_at', async () => {
  const f = fakes({ 'a@b.com': { status: 'found', names: ['A'] } });
  const counts = await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: ['A'], baseline_done: true }], ...f });
  assert.equal(f.sent.length, 0);
  assert.deepEqual(Object.keys(f.patched[0][1]), ['last_checked_at']);
  assert.equal(counts.alerted, 0);
});
test('hibp error skips subscriber: no mail, no patch, counted', async () => {
  const f = fakes({ 'a@b.com': { status: 'error', names: [] } });
  const counts = await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: [], baseline_done: true }], ...f });
  assert.equal(f.sent.length, 0);
  assert.equal(f.patched.length, 0);
  assert.equal(counts.errors, 1);
});
test('send failure does not mark breach known (retries next day)', async () => {
  const f = fakes({ 'a@b.com': { status: 'found', names: ['C'] } });
  f.sendAlert = async () => false;
  const counts = await processSubscribers({
    subscribers: [{ id: 1, email: 'a@b.com', known_breaches: [], baseline_done: true }], ...f });
  assert.equal(f.patched.length, 0);
  assert.equal(counts.errors, 1);
});

import { planSignup } from './_breach-watch.mjs';

test('planSignup inserts a new pending free_capture row', () => {
  const p = planSignup(null, { email: 'a@b.com', lang: 'es' });
  assert.equal(p.action, 'insert');
  assert.equal(p.row.status, 'pending');
  assert.equal(p.row.plan, 'free_capture');
  assert.equal(p.row.email, 'a@b.com');
});
test('planSignup asks an unsubscribed row to reconfirm', () => {
  const p = planSignup({ id: 5, status: 'unsubscribed' }, { email: 'a@b.com', lang: 'en' });
  assert.equal(p.action, 'reconfirm');
  assert.equal(p.patch.status, 'pending');
});
test('planSignup asks a pending row to reconfirm (endpoint throttles)', () => {
  const p = planSignup({ id: 5, status: 'pending' }, { email: 'a@b.com', lang: 'es' });
  assert.equal(p.action, 'reconfirm');
  assert.equal(p.patch.status, 'pending');
});

for (const status of ['active', 'paused']) {
  test(`planSignup is a noop for a ${status} row`, () => {
    assert.deepEqual(planSignup({ id: 5, status }, { email: 'a@b.com', lang: 'es' }), { action: 'noop' });
  });
}

import { breachConfirmCopy, breachWelcomeCopy, breachAlertCopy } from './_breach-watch.mjs';

test('confirm copy has a subject per lang and differs by lang', () => {
  const es = breachConfirmCopy('es');
  const en = breachConfirmCopy('en');
  assert.ok(es.subject.length > 0 && en.subject.length > 0);
  assert.notEqual(es.subject, en.subject);
  assert.ok(es.lines.length > 0);
});
test('welcome copy lists current exposure and differs by lang', () => {
  const es = breachWelcomeCopy('es', ['LinkedIn']);
  const en = breachWelcomeCopy('en', ['LinkedIn']);
  assert.ok(es.lines.join(' ').includes('LinkedIn'));
  assert.notEqual(es.subject, en.subject);
});
test('welcome copy handles a clean result', () => {
  const es = breachWelcomeCopy('es', []);
  assert.ok(es.lines.length > 0);
});
test('alert copy names the new breaches', () => {
  const es = breachAlertCopy('es', ['Dropbox']);
  assert.ok(es.lines.join(' ').includes('Dropbox'));
});
