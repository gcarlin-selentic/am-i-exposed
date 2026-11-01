// Pure claim-matching for the cross-check funnel. No DOM and no module syntax,
// so the same file loads as a classic <script> in the browser (window.FunnelMatch)
// and is importable for side effect by node:test (globalThis.FunnelMatch).
//
// Given the visitor's breached-email set, the companies they ticked in Paso 2
// and their state, it returns the settlements they might be able to claim, the
// "up to $X" per-person total and how many are open right now. It decides
// nothing about money or eligibility beyond what the data already says: the
// amounts are published maximums, labelled "up to" by the UI, never a promise.
(function (root) {
  'use strict';

  function rowFrom(src, extra) {
    return {
      empresa: src.empresa || src.titulo || '',
      slug: src.slug,
      porPersona: src.porPersona != null ? src.porPersona : null,
      fondo: src.fondo != null ? src.fondo : null,
      plazo: src.plazo || null,
      sitio: src.sitio || null,
      ...extra,
    };
  }

  function selectClaimable(opts) {
    const o = opts || {};
    const breaches = new Set(o.breaches || []);
    const companies = new Set(o.companies || []);   // slugs the visitor ticked
    const matched = o.matched || [];                // settlements.json.filas
    const open = o.open || [];                       // funnel.json.open
    const state = o.state || '';
    const todayISO = o.todayISO || '';

    // email wins over a ticked chip for the same company, so it goes in first.
    const bySlug = new Map();
    for (const m of matched) {
      if (!m || !m.slug || !breaches.has(m.hibp)) continue;
      if (!bySlug.has(m.slug)) {
        bySlug.set(m.slug, rowFrom(m, { abierto: false, source: 'email' }));
      }
    }
    for (const op of open) {
      if (!op || !op.slug || !companies.has(op.slug)) continue;
      if (bySlug.has(op.slug)) continue;            // email already has it
      bySlug.set(op.slug, rowFrom(op, { abierto: true, source: 'company' }));
    }

    const items = Array.from(bySlug.values());
    const totalMax = items.reduce((s, it) => s + (it.porPersona || 0), 0);
    const openCount = items.filter(
      it => it.plazo && todayISO && it.plazo >= todayISO).length;

    return { items, totalMax, openCount, hasState: !!state };
  }

  root.FunnelMatch = { selectClaimable };
})(typeof window !== 'undefined' ? window : globalThis);
