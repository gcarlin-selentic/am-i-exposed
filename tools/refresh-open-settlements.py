#!/usr/bin/env python3
"""Busca, cada semana, los acuerdos que todavia se pueden reclamar.

Reemplaza a refresh-cases.py, que descargaba miles de paginas para reconstruir
un archivo historico. Eso estaba mal planteado por dos razones.

La primera es que no funcionaba: TopClassActions devolvia 403 en la mitad de
las descargas y el conteo salia inventado. La segunda es mas de fondo: un
acuerdo cerrado no vuelve a cambiar nunca. Refrescarlo cada semana es releer
el periodico del ano pasado. Lo que cambia, y lo unico por lo que alguien
pagaria tres dolares al mes, son los que estan abiertos ahora y vencen pronto.

Y son pocos. Decenas, no miles. Caben en seis paginas indice, y Firecrawl las
devuelve ya estructuradas en una llamada cada una.

El filtro contra noticias falsas y blogs

Un acuerdo colectivo lo administra alguien que designa el juez, y ese
administrador monta un sitio propio donde se presenta la reclamacion. Eso da
una prueba mecanica que no requiere opinar sobre si una fuente es seria:

  1. Sin sitio de reclamo no se publica. Mata la especulacion de blog, que
     nunca tiene uno porque el acuerdo todavia no existe.
  2. El dominio tiene que resolver en DNS. Un nombre inventado no resuelve.
  3. El dominio no puede ser el del agregador ni el de un afiliado: tiene que
     ser propio del acuerdo.
  4. El plazo tiene que leerse como fecha, y no haber pasado.
  5. CourtListener, la API gratuita de expedientes federales, se consulta como
     senal a favor, nunca como requisito: cubre sobre todo lo federal y muchos
     acuerdos buenos son de tribunal estatal. Marcar, no descartar.

Lo que no pasa del 1 al 4 no se publica, y el informe dice cuantos cayo y por
que, para que un cambio de maqueta en una fuente se note en vez de vaciar el
archivo en silencio.

Requiere FIRECRAWL_API_KEY. En GitHub Actions va como secreto del repositorio.

Uso:
  python3 tools/refresh-open-settlements.py
  python3 tools/refresh-open-settlements.py --dry-run   no escribe nada
"""
import datetime, json, os, re, socket, sys, time
import urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import _claim_site as claim_site

API = 'https://api.firecrawl.dev/v2/scrape'
CLAVE = os.environ.get('FIRECRAWL_API_KEY', '').strip()
HOY = datetime.date.today()
SECO = '--dry-run' in sys.argv

# Los dominios de quien publica la lista. Si el "sitio de reclamo" es uno de
# estos, la extraccion se quedo con el enlace del agregador en vez del
# administrador, y eso no se publica como sitio oficial.
AGREGADORES = {
    'classaction.org', 'www.classaction.org', 'topclassactions.com',
    'www.topclassactions.com', 'claimdepot.com', 'www.claimdepot.com',
    'dapeer.com', 'www.dapeer.com', 'openclassactions.com', 'ftc.gov',
    'www.ftc.gov', 'consumer.ftc.gov', 'am-i-exposed.com', 'www.am-i-exposed.com',
}

# Un dominio de administrador se llama como el caso: casi siempre lleva
# "settlement", "claims" o "litigation" dentro. Comprobado contra los 19 que ya
# teniamos verificados: 18 cumplen, y el que no es ftc.gov, que va aparte por
# ser gobierno. Esto es lo que separa landsenddatasettlement.com de evil.com,
# porque evil.com tambien resuelve y tampoco es un agregador.
PISTAS_DOMINIO = ('settlement', 'claims', 'claim', 'litigation', 'classaction',
                  'class', 'lawsuit', 'databreach', 'breach', 'suit', 'fund',
                  'recovery', 'payout')
GOBIERNO = ('ftc.gov', 'justice.gov', 'usdoj.gov', 'sec.gov', 'cfpb.gov', 'hhs.gov')

# Los administradores grandes alojan los casos bajo su propia marca, asi que
# su dominio no se llama como el acuerdo y la prueba de arriba los tumbaba.
# La primera corrida rechazo cinco de Kroll, que administra cientos de casos.
# Son empresas designadas por tribunales, no dominios que cualquiera registra.
ADMINISTRADORES = (
    'kroll.com', 'ra.kroll.com', 'angeiongroup.com', 'epiqglobal.com',
    'epiqglobal.eu', 'jndla.com', 'simpluris.com', 'veritaglobal.com',
    'kccllc.net', 'gilardi.com', 'rg2claims.com', 'dahladmin.com',
    'atticusadmin.com', 'postlethwaite.com', 'cptgroup.com', 'noticeadmin.com',
    'settlementalliance.com', 'classactionadministration.com',
)

ESQUEMA = {
    'type': 'object',
    'properties': {
        'settlements': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'name': {'type': 'string', 'description': 'Nombre del acuerdo tal como aparece'},
                    'company': {'type': 'string', 'description': 'Solo la empresa demandada, sin montos ni "class action settlement"'},
                    'about': {'type': 'string', 'description': 'Quien esta cubierto, en una frase'},
                    'deadline': {'type': 'string', 'description': 'Fecha limite para reclamar, tal cual aparece'},
                    'max_per_person': {'type': 'string'},
                    'total_fund': {'type': 'string'},
                    'proof_required': {'type': 'string', 'description': 'Si hace falta comprobante: yes, no o unknown'},
                    'claim_site': {'type': 'string', 'description': 'URL del sitio OFICIAL del administrador donde se reclama, no la del sitio que publica la lista'},
                    'case_name': {'type': 'string', 'description': 'Nombre del caso y tribunal si aparecen'},
                    'is_data_breach': {'type': 'boolean', 'description': 'true si el caso es por filtracion de datos o privacidad'},
                    'detail_url': {'type': 'string', 'description': 'URL de la pagina de ESTE acuerdo dentro de este mismo sitio, la ficha a la que lleva su titulo'},
                },
            },
        },
    },
}

PETICION = ('Extract every settlement listed on this page that is currently OPEN for '
            'claims. For each one give the company being sued, who is covered, the '
            'claim deadline exactly as written, the maximum payout per person, the '
            'total fund, whether proof of purchase is required, and the official '
            'settlement administrator website where a claim is filed. The claim site '
            'must be the administrator\'s own domain, never this page\'s own domain. '
            'Mark is_data_breach true when the case is about a data breach, a hack, '
            'ransomware or a privacy violation. Skip anything that is a news story '
            'about a proposed or rejected settlement rather than one accepting claims.')

FUENTES = [
    ('classaction.org', 'https://www.classaction.org/settlements'),
    ('topclassactions', 'https://topclassactions.com/lawsuit-settlements/open-lawsuit-settlements/'),
    ('claimdepot', 'https://www.claimdepot.com/settlements'),
    ('ftc', 'https://www.ftc.gov/enforcement/refunds'),
    ('jnd', 'https://www.jndla.com/cases'),
    ('kroll', 'https://cases.ra.kroll.com'),
]


def firecrawl(url):
    cuerpo = json.dumps({
        'url': url,
        'onlyMainContent': True,
        'maxAge': 0,
        'formats': [{'type': 'json', 'prompt': PETICION, 'schema': ESQUEMA}, 'links'],
    }).encode()
    req = urllib.request.Request(API, data=cuerpo, headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {CLAVE}',
    })
    for n in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.loads(r.read())
            dd = d.get('data') or {}
            return dd.get('json') or {}, dd.get('links') or []
        except urllib.error.HTTPError as e:
            print(f'    HTTP {e.code} en {url}', file=sys.stderr)
            if e.code in (402, 401, 403):
                return {}, []
            time.sleep(10 * (n + 1))
        except Exception as e:
            print(f'    {e} en {url}', file=sys.stderr)
            time.sleep(10 * (n + 1))
    return {}, []


MESES = ('january february march april may june july august september october '
         'november december').split()


def fecha(txt):
    """Devuelve ISO, o None si no es una fecha. "Varies" no es una fecha, y
    tratarla como una seria inventarle un plazo a un acuerdo que no lo tiene."""
    t = re.sub(r'\s+', ' ', (txt or '')).strip().rstrip('.')
    if not t or re.search(r'var(y|ies)|ongoing|rolling|n/?a|unknown|none|tbd', t, re.I):
        return None
    for f in ('%m/%d/%Y', '%m/%d/%y', '%B %d, %Y', '%b %d, %Y', '%Y-%m-%d',
              '%d %B %Y', '%B %d %Y', '%b %d %Y'):
        try:
            return datetime.datetime.strptime(t, f).date().isoformat()
        except ValueError:
            pass
    m = re.search(r'([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})', t, re.I)
    if m:
        mes = next((i for i, x in enumerate(MESES, 1)
                    if x.startswith(m.group(1).lower()[:3])), None)
        if mes:
            try:
                return datetime.date(int(m.group(3)), mes, int(m.group(2))).isoformat()
            except ValueError:
                pass
    m = re.search(r'(\d{1,2})/(\d{1,2})/(\d{2,4})', t)
    if m:
        a = int(m.group(3))
        a += 2000 if a < 100 else 0
        try:
            return datetime.date(a, int(m.group(1)), int(m.group(2))).isoformat()
        except ValueError:
            pass
    return None


def dinero(txt):
    """El mayor importe del texto, no el primero.

    Los rangos se escriben "$60 - $5,000" y el campo dice maximo por persona,
    asi que quedarse con el primero convertiria el acuerdo de Lands' End en
    sesenta dolares en vez de cinco mil."""
    if not txt:
        return None
    vals = []
    for m in re.finditer(r'\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion|m\b|b\b)?',
                         str(txt), re.I):
        try:
            v = float(m.group(1).replace(',', ''))
        except ValueError:
            continue
        u = (m.group(2) or '').lower()
        if u.startswith('b'):
            v *= 1_000_000_000
        elif u:
            v *= 1_000_000
        vals.append(int(v))
    return max(vals) if vals else None


_dns = {}


def resuelve(host):
    if host in _dns:
        return _dns[host]
    try:
        socket.getaddrinfo(host, None)
        _dns[host] = True
    except Exception:
        _dns[host] = False
    return _dns[host]


def courtlistener(caso):
    """Senal a favor, nunca requisito: cubre sobre todo tribunales federales."""
    if not caso or len(caso) < 8:
        return False
    q = urllib.parse.quote(caso[:120])
    try:
        req = urllib.request.Request(
            f'https://www.courtlistener.com/api/rest/v4/search/?q={q}&type=r',
            headers={'User-Agent': 'am-i-exposed/1.0 (+https://www.am-i-exposed.com/)'})
        with urllib.request.urlopen(req, timeout=30) as r:
            return (json.loads(r.read()).get('count') or 0) > 0
    except Exception:
        return False


def enlazado(host, enlaces):
    """El dominio aparece como enlace de verdad en la pagina.

    Esta es la frontera de seguridad, no el nombre del dominio. Un texto
    inyectado puede decirle al modelo que conteste lo que sea; no puede crear
    un <a href>. Para poner aqui un dominio propio hay que controlar la pagina
    de la fuente, que es otro problema y mucho mas ruidoso.

    Compara el host entero, no por subcadena: "landsenddatasettlement.com"
    aparece dentro de "evil.com/?r=landsenddatasettlement.com" y eso no es
    estar enlazado, es estar citado en el parametro de otro.
    """
    objetivo = host.lower().removeprefix('www.')
    for u in enlaces or ():
        try:
            h = urllib.parse.urlsplit(u if '://' in str(u) else '//' + str(u)).hostname
        except Exception:
            continue
        if not h:
            continue
        h = h.lower().removeprefix('www.')
        if h == objetivo or h.endswith('.' + objetivo):
            return True
    return False


def nombre_plausible(host, empresa):
    """Filtro de calidad, no de seguridad.

    Atrapa errores de extraccion: un dominio que no se llama como ningun
    acuerdo probablemente es que el modelo cogio el enlace equivocado. No
    atrapa a un atacante, porque registrar "algo-settlement.com" cuesta diez
    dolares. Lo que detiene a un atacante es enlazado(), de ahi que las dos
    tengan que pasar y no valga con una.
    """
    h = host.lower().removeprefix('www.')
    if any(h == g or h.endswith('.' + g) for g in GOBIERNO):
        return True
    if any(h == a or h.endswith('.' + a) for a in ADMINISTRADORES):
        return True
    if any(p in h for p in PISTAS_DOMINIO):
        return True
    plano = re.sub(r'[^a-z0-9]', '', (empresa or '').lower())
    return len(plano) >= 5 and plano in re.sub(r'[^a-z0-9]', '', h)


def verificar(r, fuente, enlaces):
    """Devuelve (registro limpio, None) o (None, motivo del descarte).

    `enlaces` son los href reales de la pagina, y son obligatorios. Sin ellos
    no hay forma de corroborar lo que dijo el modelo, asi que no se publica
    nada: una comprobacion que se salta sola cuando le falta su entrada no es
    una comprobacion, y seria el modo de desactivarla.
    """
    sitio = claim_site.mostrar(r.get('claim_site'))
    if not sitio:
        return None, 'sin sitio de reclamo valido'
    host = sitio.split('/')[0].lower()
    ruta = sitio[len(host):].strip('/')
    es_gob = any(host.removeprefix('www.') == g or host.endswith('.' + g) for g in GOBIERNO)
    # Un dominio de gobierno es fuente y destino a la vez: ftc.gov publica la
    # lista y tambien aloja la reclamacion de cada caso. Vale el enlace hondo,
    # no la portada, que seria devolvernos al indice del que salio.
    if es_gob:
        if len(ruta.split('/')) < 3:
            return None, 'enlace de gobierno sin caso concreto'
    elif host in AGREGADORES or host.removeprefix('www.') in AGREGADORES:
        return None, 'el sitio es del agregador, no del administrador'
    # Las dos, no una. enlazado() es la que detiene a un atacante;
    # nombre_plausible() solo descarta extracciones torcidas.
    if not nombre_plausible(host, r.get('company')):
        return None, f'el dominio no parece de un acuerdo: {host}'
    if not enlaces:
        return None, 'la pagina no devolvio enlaces: no se puede corroborar'
    if not enlazado(host, enlaces):
        return None, f'el dominio no aparece enlazado en la pagina: {host}'
    if not resuelve(host):
        return None, f'el dominio no resuelve: {host}'

    plazo = fecha(r.get('deadline'))
    if plazo and plazo < HOY.isoformat():
        return None, f'plazo vencido: {plazo}'

    empresa = re.sub(r'\s+', ' ', (r.get('company') or r.get('name') or '')).strip()
    empresa = re.sub(r'\s*(class action|settlement|data breach|lawsuit)\s*', ' ', empresa, flags=re.I).strip(' -,')
    if len(empresa) < 2:
        return None, 'sin nombre de empresa'

    return {
        'empresa': empresa,
        'nombre': (r.get('name') or '').strip(),
        'cubre': re.sub(r'\s+', ' ', (r.get('about') or '')).strip()[:400],
        'plazo': plazo,
        'plazo_texto': (r.get('deadline') or '').strip(),
        'pago_por_persona': dinero(r.get('max_per_person')),
        'pago_texto': (r.get('max_per_person') or '').strip()[:80],
        'fondo': dinero(r.get('total_fund')),
        'comprobante': (r.get('proof_required') or '').strip().lower()[:12],
        'sitio_reclamo': sitio,
        'caso': (r.get('case_name') or '').strip()[:200],
        'filtracion': bool(r.get('is_data_breach')),
        'fuente': fuente,
        'visto': HOY.isoformat(),
    }, None


def main():
    if not CLAVE:
        raise SystemExit('falta FIRECRAWL_API_KEY')

    previos = {}
    p = os.path.join(ROOT, 'data', 'open-settlements.json')
    if os.path.exists(p):
        for r in json.load(open(p, encoding='utf-8')):
            previos[r['sitio_reclamo'].split('/')[0].lower()] = r

    vivos, descartes, segunda = {}, {}, []

    def guardar_vivo(limpio):
        # Deduplicado por dominio del administrador: es la identidad real del
        # acuerdo, mas estable que su titulo en cada agregador.
        k = limpio['sitio_reclamo'].split('/')[0].lower()
        if k not in vivos or (limpio['plazo'] and not vivos[k]['plazo']):
            limpio['visto_primero'] = previos.get(k, {}).get('visto_primero', HOY.isoformat())
            vivos[k] = limpio

    for nombre, url in FUENTES:
        print(f'{nombre} ...', flush=True)
        d, enlaces = firecrawl(url)
        filas = d.get('settlements') or []
        print(f'  {len(filas)} extraidos', flush=True)
        for r in filas:
            limpio, motivo = verificar(r, nombre, enlaces)
            if limpio:
                guardar_vivo(limpio)
                continue
            # La pagina indice a menudo no muestra el enlace del administrador,
            # asi que el modelo devuelve lo unico que tiene: la URL del propio
            # agregador. En la primera corrida eso descarto 17 acuerdos, el
            # doble de los que acepto. No son falsos, son incompletos, y la
            # ficha del acuerdo si lleva el enlace bueno.
            detalle = (r.get('detail_url') or '').strip()
            if detalle and motivo in ('el sitio es del agregador, no del administrador',
                                      'sin sitio de reclamo valido',
                                      'enlace de gobierno sin caso concreto'):
                segunda.append((nombre, detalle, r))
                continue
            descartes[motivo] = descartes.get(motivo, 0) + 1

    if segunda:
        print(f'\nsegunda pasada: {len(segunda)} fichas por abrir', flush=True)
        for nombre, detalle, r in segunda:
            d, enlaces = firecrawl(detalle)
            # La ficha habla de un solo acuerdo, asi que sus enlaces son del
            # caso y no del catalogo entero. Corroborar aqui es mas estrecho
            # que hacerlo contra un indice lleno de anuncios y patrocinios.
            filas = d.get('settlements') or []
            cand = filas[0] if filas else {}
            fundido = {**r, **{k: v for k, v in cand.items() if v}}
            limpio, motivo = verificar(fundido, nombre, enlaces)
            if limpio:
                guardar_vivo(limpio)
            else:
                descartes[f'{motivo} (2a pasada)'] = descartes.get(f'{motivo} (2a pasada)', 0) + 1

    salida = sorted(vivos.values(), key=lambda r: (r['plazo'] or '9999', r['empresa'].lower()))
    for r in salida:
        r['en_tribunal'] = courtlistener(r['caso']) if r['caso'] else False

    conf = sum(1 for r in salida if r['plazo'])
    bd = sum(1 for r in salida if r['filtracion'])
    sinc = sum(1 for r in salida if r['comprobante'].startswith('n'))
    print(f'\nabiertos verificados     {len(salida)}')
    print(f'  con plazo con fecha    {conf}')
    print(f'  por filtracion de datos{bd:>4}')
    print(f'  sin comprobante        {sinc}')
    print(f'  con expediente federal {sum(1 for r in salida if r["en_tribunal"])}')
    if descartes:
        print('\ndescartados:')
        for k, v in sorted(descartes.items(), key=lambda kv: -kv[1]):
            print(f'  {v:>4}  {k}')

    proximos = [r for r in salida if r['plazo'] and r['plazo'] <= (HOY + datetime.timedelta(days=30)).isoformat()]
    if proximos:
        print(f'\nvencen en 30 dias ({len(proximos)}):')
        for r in proximos[:15]:
            pago = f"${r['pago_por_persona']:,}" if r['pago_por_persona'] else (r['pago_texto'] or '?')
            print(f"  {r['plazo']}  {r['empresa'][:30]:<32}{pago:<12}{r['sitio_reclamo']}")

    if SECO:
        print('\n--dry-run: no se escribio nada')
        return
    if not salida:
        raise SystemExit('cero acuerdos verificados: no se sobreescribe el archivo')
    json.dump(salida, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'\nescrito data/open-settlements.json')


if __name__ == '__main__':
    main()
