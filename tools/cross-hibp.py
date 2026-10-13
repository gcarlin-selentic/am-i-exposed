#!/usr/bin/env python3
"""Matches Have I Been Pwned breaches against the case catalogue.

This is the step that turns "a company was sued" into "the company that leaked
*your* address was sued", which is the only version anybody cares about.

Matching is the dangerous part, and the danger is one-sided: telling somebody
they have money coming from a company they never used is far worse than
missing a match. Three rules, each one earned by a false positive that got
through an earlier version:

  Whole tokens, never substrings. "Canva" matched "Canvas", "Apollo" matched
  "ApolloMD", "Creative" matched "Creative Services". Each of those would have
  been a lie told to a stranger about their own money.

  Corporate suffixes are dropped before comparing, so "Fluke Corporation" and
  "Fluke" are the same company, but nothing else collapses.

  Credential dumps are not companies. Collection #1 and Exploit.In are lists
  assembled by thieves out of hundreds of breaches. Nobody can be sued for
  them, and HIBP flags them, so they are excluded before matching starts.

Anything still doubtful after that is kept with dudoso: true and never shown.
Wendy's is the standing example: HIBP's entry is wendys.com.ph, the Philippine
franchise, and the settlement is the United States chain. Same name, different
company, and the reader would have no way to tell.

Writes data/hibp-matched.json and settlements.json, the second being what the
site actually fetches.
"""
import json, os, re, sys, unicodedata, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _claim_site as claim_site

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')

STOP = {'inc', 'llc', 'llp', 'co', 'corp', 'corporation', 'company', 'ltd', 'lp',
        'pllc', 'pc', 'group', 'holdings', 'the', 'and', 'of', 'services',
        'service', 'health', 'healthcare', 'systems', 'system', 'data', 'breach',
        'class', 'action', 'settlement', 'com', 'plc', 'incorporated'}

# Verificados a mano contra el dominio que HIBP publica. No volver a meterlos
# sin repetir esa comprobacion.
EXCLUIR = {'Creative'}          # HIBP creative.com (Creative Technology) != Creative Services
DUDOSO = {'Wendys'}             # HIBP wendys.com.ph != la cadena de EE. UU.

# Mismo sitio, nombre distinto en cada catalogo. La regla de tokens exactos no
# los une, y aflojarla para que lo haga es lo que devolvia Apollo.io contra
# Apollo Global Management. Asi que van uno a uno y a mano, y cada linea dice
# con que se comprobo. Nombre de HIBP -> nombre de la empresa en el catalogo.
EQUIVALENTES = {
    # HIBP publica kemper.com; Kemper Corp es la matriz de Infinity Insurance
    # y el caso cubre las dos filtraciones bajo ese mismo grupo.
    'Kemper': 'Kemper Corp Infinity Insurance',
}


def norm(s):
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def core(s):
    return tuple(w for w in norm(s).split() if w not in STOP and len(w) > 2)


def slugify(s):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', (s or '').lower())).strip('-')


def cargar(n, d=None):
    p = os.path.join(DATA, n)
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else (d if d is not None else [])


def demandable(b):
    """Una empresa a la que se puede demandar, no un volcado de credenciales."""
    return not (b.get('IsSpamList') or b.get('IsStealerLog')
                or b.get('IsMalware') or b.get('IsFabricated'))


def main():
    hibp = [b for b in cargar('hibp-breaches.json') if demandable(b)]
    tca = cargar('tca-settlements.json')
    cao = cargar('cao-lawsuits.json')
    if not hibp:
        raise SystemExit('falta data/hibp-breaches.json: corre tools/refresh-cases.py primero')
    print(f'HIBP demandables {len(hibp)} | acuerdos {len(tca)} | demandas {len(cao)}')

    def indexar(filas, clave):
        idx = {}
        for r in filas:
            c = core(r.get(clave))
            if c:
                idx.setdefault(c, []).append(r)
        return idx

    def cruzar(filas, clave, fuente):
        idx = indexar(filas, clave)
        out = []
        for b in hibp:
            if b['Name'] in EXCLUIR:
                continue
            equiv = EQUIVALENTES.get(b['Name'])
            for campo in ('Name', 'Title', '_equiv'):
                c = core(equiv) if campo == '_equiv' else core(b.get(campo))
                if c and c in idx:
                    for r in idx[c]:
                        out.append({'breach': b['Name'], 'titulo_hibp': b['Title'],
                                    'cuentas': b['PwnCount'], 'dominio': b.get('Domain'),
                                    'fecha_filtracion': b['BreachDate'],
                                    'fuente': fuente, 'registro': r})
                    break
        return out

    m_tca = cruzar(tca, 'empresa', 'topclassactions')
    m_cao = cruzar(cao, 'empresa', 'classaction.org')
    print(f'coincidencias: TCA {len(m_tca)}, CAO {len(m_cao)}')

    cruzado = []
    for m in m_tca + m_cao:
        r = m['registro']
        rec = {'hibp': m['breach'], 'titulo_hibp': m['titulo_hibp'],
               'cuentas': m['cuentas'], 'dominio': m['dominio'],
               'fecha_filtracion': m['fecha_filtracion'], 'empresa': r['empresa'],
               'fuente_catalogo': m['fuente'], 'url_caso': r['url'],
               'dudoso': m['breach'] in DUDOSO}
        if m['fuente'] == 'topclassactions':
            rec.update({'estado': 'acuerdo', 'fondo': r.get('fondo'),
                        'pago_por_persona': r.get('pago_max_persona'),
                        'premio': r.get('premio'), 'elegible': r.get('elegible'),
                        'plazo': r.get('fecha_limite'),
                        'audiencia_final': r.get('audiencia_final'),
                        'sitio_reclamo': r.get('sitio_oficial'), 'caso': r.get('caso')})
        else:
            rec.update({'estado': r.get('estado_caso'), 'fondo': r.get('fondo_acuerdo'),
                        'pago_por_persona': r.get('pago_por_persona'),
                        'plazo': None, 'sitio_reclamo': None,
                        'datos_afectados': r.get('datos'),
                        'estado_sede': r.get('estado_sede')})
        cruzado.append(rec)
    cruzado.sort(key=lambda r: -(r['cuentas'] or 0))
    json.dump(cruzado, open(os.path.join(DATA, 'hibp-matched.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    # settlements.json es lo unico de esto que el navegador descarga, asi que
    # lleva solo lo que la tarjeta pinta, y solo lo que no es dudoso.
    paginas = {p['ruta'].strip('/').split('/')[-1]
               for p in cargar('settlement-pages.json', [])}
    tarjeta, visto = [], set()
    for r in cruzado:
        if r['dudoso'] or r['estado'] != 'acuerdo' or r['hibp'] in visto:
            continue
        visto.add(r['hibp'])
        s = slugify(r['empresa'])
        tarjeta.append({'hibp': r['hibp'], 'titulo': r['empresa'], 'empresa': r['empresa'],
                        'porPersona': r.get('pago_por_persona'), 'fondo': r.get('fondo'),
                        'plazo': r.get('plazo'),
                        # Validado: este valor viene de raspar otra web y se
                        # publica como el sitio oficial donde reclamar dinero.
                        'sitio': claim_site.mostrar(r.get('sitio_reclamo')),
                        'fuente': r['url_caso'], 'elegible': r.get('elegible'),
                        'slug': s if s in paginas else None})
    tarjeta.sort(key=lambda x: -(x['porPersona'] or 0))
    json.dump(tarjeta, open(os.path.join(ROOT, 'settlements.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    hoy = datetime.date.today().isoformat()
    vivos = sum(1 for x in tarjeta if x['plazo'] and x['plazo'] >= hoy)
    print(f'filtraciones de HIBP con caso : {len({r["hibp"] for r in cruzado})}')
    print(f'en settlements.json           : {len(tarjeta)}')
    print(f'  con enlace de reclamo       : {sum(1 for x in tarjeta if x["sitio"])}')
    print(f'  con plazo todavia abierto   : {vivos}')


if __name__ == '__main__':
    main()
