#!/usr/bin/env python3
"""Refreshes the case catalogue from its sources.

Runs weekly. Ransomware does not wait for us, and a case page whose deadline
passed last Tuesday is worse than no page: it tells somebody there is money
when there is not.

Incremental on purpose. The sitemaps are a few thousand URLs; the case pages
behind them are thousands more, and refetching all of them every week would be
both slow and rude. So each run reads the sitemaps, works out which URLs it has
never seen, and fetches only those, plus anything whose deadline is close
enough that it may have moved. One request a second, and a user agent that
says who we are and where to complain.

What it collects

  Top Class Actions  /open-lawsuit-settlements/  claimable now, the ones with
                                                 money still on the table
                     /closed-settlements/        the record, which is what the
                                                 "you could already have
                                                 claimed" card is built from
  ClassAction.org    /data-breach-lawsuits/      cases before any settlement
  Have I Been Pwned  /api/v3/breaches            to match either against an
                                                 address we are asked about

Usage
  python3 tools/refresh-cases.py            incremental, the weekly run
  python3 tools/refresh-cases.py --full     refetch everything
  python3 tools/refresh-cases.py --limit N  stop after N new pages, for testing
"""
import json, os, re, sys, time, html, datetime, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
UA = ('Mozilla/5.0 (compatible; am-i-exposed/1.0; '
      '+https://www.am-i-exposed.com/ ; contact: info@selenticgroup.com)')
PAUSA = 1.0
HOY = datetime.date.today()

FULL = '--full' in sys.argv
LIMITE = None
for i, a in enumerate(sys.argv):
    if a == '--limit' and i + 1 < len(sys.argv):
        LIMITE = int(sys.argv[i + 1])

_ultimo = [0.0]


def pedir(url, intentos=3):
    for n in range(intentos):
        espera = PAUSA - (time.time() - _ultimo[0])
        if espera > 0:
            time.sleep(espera)
        _ultimo[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as err:
            if err.code in (404, 410):
                return None
            # 429 y 5xx: la fuente nos esta pidiendo que bajemos el ritmo.
            time.sleep(4 * (n + 1))
        except Exception:
            time.sleep(2 * (n + 1))
    print(f'    no se pudo: {url}', file=sys.stderr)
    return None


def cargar(nombre, por_defecto):
    p = os.path.join(DATA, nombre)
    if os.path.exists(p) and not FULL:
        try:
            return json.load(open(p, encoding='utf-8'))
        except Exception:
            pass
    return por_defecto


def guardar(nombre, dato):
    json.dump(dato, open(os.path.join(DATA, nombre), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)


def locs(xml):
    return re.findall(r'<loc>([^<]+)</loc>', xml or '')


def limpiar(s):
    s = re.sub(r'<[^>]+>', ' ', s or '')
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()


# ---------------------------------------------------------------- sitemaps
def urls_tca():
    idx = pedir('https://topclassactions.com/sitemap_index.xml')
    if not idx:
        return {}, {}
    mapas = [m for m in locs(idx) if 'post-sitemap' in m]
    print(f'  TCA: {len(mapas)} sitemaps de posts')
    abiertos, cerrados = {}, {}
    for i, m in enumerate(mapas, 1):
        s = pedir(m)
        if not s:
            continue
        for u in locs(s):
            if '/open-lawsuit-settlements/' in u:
                abiertos[u] = True
            elif '/closed-settlements/' in u:
                cerrados[u] = True
        if i % 10 == 0:
            print(f'    {i}/{len(mapas)}  abiertos {len(abiertos)}  cerrados {len(cerrados)}')
    return abiertos, cerrados


def urls_cao():
    idx = pedir('https://www.classaction.org/sitemap.xml')
    fuentes = [u for u in locs(idx or '') if 'sitemap' in u] or \
              ['https://www.classaction.org/sitemap.xml']
    vistos = {}
    for f in fuentes:
        s = pedir(f) if f != 'https://www.classaction.org/sitemap.xml' else idx
        for u in locs(s or ''):
            if '/data-breach-lawsuits/' in u:
                vistos[u] = True
    return vistos


# ------------------------------------------------------- extraccion por caso
CAMPOS_TCA = {
    'elegible': r"Who'?s Eligible\s*(.{0,600}?)(?:Potential Award|Proof of Purchase|Claim Form Deadline|Case Name)",
    'premio': r'Potential Award\s*(.{0,300}?)(?:Proof of Purchase|Claim Form Deadline|Case Name|Who)',
    'plazo_txt': r'Claim Form Deadline\s*(.{0,80}?)(?:Case Name|Who|Potential|Settlement Website)',
    'caso': r'Case Name\s*(.{0,260}?)(?:Final Hearing|Settlement Website|Claim Form)',
    'audiencia_txt': r'Final Hearing\s*(.{0,80}?)(?:Settlement Website|Claim Form|Case Name)',
    'sitio': r'Settlement Website\s*([A-Za-z0-9.\-/:]+)',
}


def fecha_iso(txt):
    txt = (txt or '').strip()
    for fmt in ('%m/%d/%Y', '%m/%d/%y', '%B %d, %Y', '%b %d, %Y'):
        try:
            return datetime.datetime.strptime(txt, fmt).date().isoformat()
        except ValueError:
            pass
    m = re.search(r'(\d{1,2})/(\d{1,2})/(\d{4})', txt)
    if m:
        try:
            return datetime.date(int(m.group(3)), int(m.group(1)), int(m.group(2))).isoformat()
        except ValueError:
            pass
    return None


def dinero(txt):
    if not txt:
        return None
    m = re.search(r'\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion|m\b)?', txt, re.I)
    if not m:
        return None
    try:
        v = float(m.group(1).replace(',', ''))
    except ValueError:
        return None
    u = (m.group(2) or '').lower()
    if u.startswith('b'):
        v *= 1_000_000_000
    elif u:
        v *= 1_000_000
    return int(v)


def parsear_tca(url, pagina, abierto):
    txt = limpiar(pagina)
    if not re.search(r'data breach|data security|data incident|cyberattack|ransomware', txt, re.I):
        return None
    r = {'url': url, 'abierto': abierto}
    for k, pat in CAMPOS_TCA.items():
        m = re.search(pat, txt, re.I | re.S)
        r[k] = m.group(1).strip(' .:·-') if m else None
    slug = url.rstrip('/').split('/')[-1]
    emp = re.sub(r'^\$?[\d.,]+[mkb]?-', '', slug)
    emp = re.sub(r'-(data|class|action|settlement|breach|security|incident|lawsuit).*$', '', emp)
    r['empresa'] = ' '.join(w.capitalize() for w in emp.split('-') if w) or None
    t = re.search(r'<title[^>]*>(.*?)</title>', pagina, re.S | re.I)
    r['titulo'] = limpiar(t.group(1)).split('|')[0].strip() if t else r['empresa']
    r['fondo'] = dinero(r['titulo'])
    r['pago_max_persona'] = dinero(r.get('premio'))
    r['fecha_limite'] = fecha_iso(r.pop('plazo_txt', None))
    r['audiencia_final'] = fecha_iso(r.pop('audiencia_txt', None))
    r['sitio_oficial'] = (r.pop('sitio', None) or '').strip('.') or None
    return r if (r['empresa'] and (r['fecha_limite'] or r['pago_max_persona'] or r['fondo'])) else None


def parsear_cao(url, pagina):
    txt = limpiar(pagina)
    slug = url.rstrip('/').split('/')[-1]
    emp = re.sub(r'-(january|february|march|april|may|june|july|august|september|october|november|december)-\d{4}$', '', slug)
    r = {'url': url, 'slug': slug,
         'empresa': ' '.join(w.capitalize() for w in emp.split('-') if w)}
    m = re.search(r'-((?:january|february|march|april|may|june|july|august|september|october|november|december)-\d{4})$', slug)
    r['fecha'] = m.group(1).replace('-', ' ').title() if m else None
    r['anio'] = int(m.group(1)[-4:]) if m else None
    if re.search(r'investigation (?:is )?(?:now )?closed|no longer (?:being )?investigat', txt, re.I):
        r['estado_caso'] = 'investigacion cerrada'
    elif re.search(r'settlement', txt, re.I) and re.search(r'reached|approved|final', txt, re.I):
        r['estado_caso'] = 'acuerdo'
    else:
        r['estado_caso'] = 'investigacion abierta'
    m = re.search(r'(?:Information (?:Affected|Involved)|data (?:was )?(?:exposed|involved))[:\s]+(.{0,200})', txt, re.I)
    r['datos'] = [x.strip() for x in re.split(r'[,;]', m.group(1))][:10] if m else None
    m = re.search(r'([\d,]{4,})\s+(?:people|individuals|customers|patients)', txt, re.I)
    r['afectados'] = int(m.group(1).replace(',', '')) if m else None
    m = re.search(r'Published[:\s]+([A-Z][a-z]+ \d{1,2}, \d{4})', txt)
    r['publicado'] = m.group(1) if m else None
    r['estado_sede'] = None
    r['estados_notificados'] = []
    r['nacional'] = False
    r['fondo_acuerdo'] = None
    r['pago_por_persona'] = None
    r['titular'] = None
    r['desc'] = None     # no se guarda: es texto editorial de la fuente
    return r


# ---------------------------------------------------------------- principal
def main():
    os.makedirs(DATA, exist_ok=True)
    tca = {r['url']: r for r in cargar('tca-settlements.json', [])}
    cao = {r['url']: r for r in cargar('cao-lawsuits.json', [])}
    print(f'catalogo actual: {len(tca)} acuerdos, {len(cao)} demandas')

    print('leyendo sitemaps')
    abiertos, cerrados = urls_tca()
    cao_urls = urls_cao()
    print(f'  TCA abiertos {len(abiertos)}, cerrados {len(cerrados)}; CAO {len(cao_urls)}')

    # Un caso abierto se vuelve a mirar aunque ya lo tengamos: su plazo se
    # mueve y su estado cambia. Uno cerrado ya no cambia nunca.
    pendientes = [(u, True) for u in abiertos if FULL or u not in tca or tca[u].get('abierto')]
    pendientes += [(u, False) for u in cerrados if FULL or u not in tca]
    pendientes_cao = [u for u in cao_urls if FULL or u not in cao]
    print(f'por descargar: {len(pendientes)} de TCA, {len(pendientes_cao)} de CAO')

    n = 0
    for u, abierto in pendientes:
        if LIMITE and n >= LIMITE:
            break
        p = pedir(u)
        n += 1
        if not p:
            continue
        r = parsear_tca(u, p, abierto)
        if r:
            tca[u] = r
        if n % 25 == 0:
            print(f'  TCA {n}/{len(pendientes)}')
            guardar('tca-settlements.json', list(tca.values()))

    m = 0
    for u in pendientes_cao:
        if LIMITE and m >= LIMITE:
            break
        p = pedir(u)
        m += 1
        if not p:
            continue
        cao[u] = parsear_cao(u, p)
        if m % 25 == 0:
            print(f'  CAO {m}/{len(pendientes_cao)}')
            guardar('cao-lawsuits.json', list(cao.values()))

    guardar('tca-settlements.json', list(tca.values()))
    guardar('cao-lawsuits.json', list(cao.values()))

    hibp = pedir('https://haveibeenpwned.com/api/v3/breaches')
    if hibp:
        guardar('hibp-breaches.json', json.loads(hibp))

    vivos = sum(1 for r in tca.values()
                if r.get('fecha_limite') and r['fecha_limite'] >= HOY.isoformat())
    print(f'\nacuerdos {len(tca)}  demandas {len(cao)}')
    print(f'con plazo abierto hoy: {vivos}')
    print('ahora: python3 tools/cross-hibp.py && python3 tools/build-settlement-pages.py'
          ' && python3 tools/build-sitemap.py')


if __name__ == '__main__':
    main()
