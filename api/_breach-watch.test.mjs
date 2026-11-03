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
