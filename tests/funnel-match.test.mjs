// Tests for funnel-match.js. The module has no export syntax (it loads as a
// classic <script> in the browser too), so importing it runs it for side
// effect and sets globalThis.FunnelMatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../funnel-match.js';

const { selectClaimable } = globalThis.FunnelMatch;

const MATCHED = [
  { hibp: 'Yahoo', empresa: 'Yahoo', slug: 'yahoo', tipo: 'acuerdo',
    porPersona: 25000, fondo: null, plazo: '2020-07-20', sitio: 'yahoo.com' },
];
const OPEN = [
  { empresa: 'CVS', slug: 'cvs', porPersona: 10, fondo: null,
    plazo: '2026-11-16', sitio: 'cvs.com', hibp: false },
  { empresa: 'Johnson Johnson', slug: 'johnson-johnson', porPersona: null,
    fondo: 4700000, plazo: '2026-11-25', sitio: 'jj.com', hibp: false },
  { empresa: 'Yahoo', slug: 'yahoo', porPersona: 5000, fondo: null,
    plazo: '2026-12-01', sitio: 'yahoo.com', hibp: true },
];
const TODAY = '2026-11-01';

test('email breach matches a settlement', () => {
  const r = selectClaimable({ breaches: ['Yahoo'], matched: MATCHED, open: [],
    companies: [], state: '', todayISO: TODAY });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].source, 'email');
  assert.equal(r.totalMax, 25000);
});

test('picked company surfaces an open settlement, counted as open', () => {
  const r = selectClaimable({ breaches: [], matched: MATCHED, open: OPEN,
    companies: ['cvs'], state: '', todayISO: TODAY });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].source, 'company');
  assert.equal(r.openCount, 1);
});

test('same slug from email and company counts once, email wins', () => {
  const r = selectClaimable({ breaches: ['Yahoo'], matched: MATCHED, open: OPEN,
    companies: ['yahoo'], state: '', todayISO: TODAY });
  const yahoos = r.items.filter(i => i.slug === 'yahoo');
  assert.equal(yahoos.length, 1);
  assert.equal(yahoos[0].source, 'email');
  assert.equal(r.totalMax, 25000);
});

test('a fund-only open row is an item but not in the per-person total', () => {
  const r = selectClaimable({ breaches: [], matched: [], open: OPEN,
    companies: ['johnson-johnson'], state: '', todayISO: TODAY });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].porPersona, null);
  assert.equal(r.totalMax, 0);
});

test('no breaches and no companies yields nothing', () => {
  const r = selectClaimable({ breaches: [], matched: MATCHED, open: OPEN,
    companies: [], state: '', todayISO: TODAY });
  assert.equal(r.items.length, 0);
  assert.equal(r.totalMax, 0);
  assert.equal(r.openCount, 0);
});

test('state is a modifier, not a filter', () => {
  const r = selectClaimable({ breaches: [], matched: [], open: OPEN,
    companies: ['cvs', 'johnson-johnson'], state: 'California', todayISO: TODAY });
  assert.equal(r.hasState, true);
  assert.equal(r.items.length, 2);
});

test('open-only total and items exclude a closed email match', () => {
  // Yahoo (email) closed in 2020; CVS (company) open. The claimable headline
  // must count only the open one, not the closed settlement.
  const r = selectClaimable({ breaches: ['Yahoo'], matched: MATCHED, open: OPEN,
    companies: ['cvs'], state: '', todayISO: TODAY });
  assert.equal(r.items.length, 2);            // both still returned
  assert.equal(r.totalMax, 25010);            // all-items total unchanged
  assert.equal(r.openItems.length, 1);        // only the open one is claimable
  assert.equal(r.openItems[0].slug, 'cvs');
  assert.equal(r.openTotalMax, 10);           // closed Yahoo excluded
});
