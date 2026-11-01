"""Pure dataset for the money/number cross-check funnel.

Kept out of build-settlement-pages.py on purpose: that script runs its whole
build (reads the source JSON, writes 1,081 pages) the moment it is imported, so
it cannot be unit-tested. This stays a plain importable module.

Input `casos` are the index rows build-settlement-pages.py already builds:
{ruta, empresa, tipo, fondo, pago, plazo, abierto, sitio, en_hibp}. The funnel
reads the same rows the /settlements/ hub counts, so the numbers cannot drift.
"""

# Los tipos que son casos reales, no paginas de indice (letras, hub).
PUBLICABLES = {'acuerdo', 'abierto', 'investigacion abierta', 'demanda presentada'}


def _slug_de_ruta(ruta):
    return (ruta or '').strip('/').split('/')[-1]


def build_funnel(casos, hoy):
    """Return {meta, open, chips} for the funnel, from the index rows.

    - meta.casos/acuerdos/abiertos are the publishable universe (same source as
      the hub page), so no visitor-facing count can disagree with another.
    - open: every case still claimable (abierto, future deadline), by deadline.
    - chips: Paso-2 candidate companies, open ones first then the highest-paying
      HIBP-matched ones, unique by slug, capped so the picker stays short.
    """
    pub = [c for c in casos if c.get('tipo') in PUBLICABLES]
    abiertos = sorted((c for c in pub if c.get('abierto')),
                      key=lambda c: (c.get('plazo') or '9999-12-31'))

    open_rows = [{
        'empresa': c['empresa'],
        'slug': _slug_de_ruta(c['ruta']),
        'porPersona': c.get('pago'),
        'fondo': c.get('fondo'),
        'plazo': c.get('plazo'),
        'sitio': c.get('sitio'),
        'hibp': bool(c.get('en_hibp')),
    } for c in abiertos]

    # El "hasta $X" se suma solo de montos por persona; un fondo total no es
    # lo que cobra una persona, asi que no entra en el maximo.
    max_pp = max((o['porPersona'] for o in open_rows if o['porPersona']), default=0)

    chips, vistos = [], set()
    for o in open_rows:
        if o['slug'] not in vistos:
            vistos.add(o['slug'])
            chips.append({'empresa': o['empresa'], 'slug': o['slug']})
    matched = sorted((c for c in pub if c.get('en_hibp') and c.get('pago')),
                     key=lambda c: -(c.get('pago') or 0))
    for c in matched:
        if len(chips) >= 16:
            break
        s = _slug_de_ruta(c['ruta'])
        if s not in vistos:
            vistos.add(s)
            chips.append({'empresa': c['empresa'], 'slug': s})

    return {
        'meta': {
            'casos': len(pub),
            'acuerdos': sum(1 for c in pub if c.get('tipo') == 'acuerdo'),
            'abiertos': len(abiertos),
            'maxPorPersona': max_pp,
        },
        'open': open_rows,
        'chips': chips,
    }
