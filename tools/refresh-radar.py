#!/usr/bin/env python3
"""Arma data/radar.json, la fuente del Daily Hack.

Dos fuentes, las dos con licencia que permite republicar:

  RansomLook        CC BY 4.0, https://www.ransomlook.io/about
  Have I Been Pwned CC BY 4.0, https://haveibeenpwned.com/API/v3

Ransomware.live NO esta aqui a proposito. Sus terminos (seccion 5.2) prohiben
el uso comercial sin autorizacion escrita, y la seccion 4 prohibe publicar sus
datos crudos en cualquier forma. Este sitio vende un reporte, asi que es uso
comercial. Si llega el permiso, se agrega una fuente mas en FUENTES y nada mas
cambia.

Lo que RansomLook no da es pais ni industria: su API devuelve victima, grupo y
fecha, y nada mas. Esa clasificacion la hacemos nosotros, una sola vez por
victima nueva, con la API de Claude. Es trabajo propio, no un campo copiado de
nadie. Sin ANTHROPIC_API_KEY el script sigue corriendo y los registros quedan
sin pais ni industria, que la pagina muestra como "Sin identificar": es feo,
pero es cierto, que es mas de lo que se puede decir de adivinarlo.

Uso: python3 tools/refresh-radar.py [--dry-run] [--days N]
"""
import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _radar import SECTORES, PAISES  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESTINO = os.path.join(ROOT, 'data', 'radar.json')

# Cuanto historico se guarda. La pagina solo muestra una semana; el resto
# queda para las cifras de 30 dias y para no volver a clasificar lo mismo.
VENTANA_DIAS = 180

# Cuantos posts pedirle a RansomLook. Publica del orden de 40 al dia, asi que
# 400 cubre mas de una semana aunque el trabajo falle varios dias seguidos.
RECIENTES = 400

FUENTES = [
    {'nombre': 'RansomLook', 'url': 'https://www.ransomlook.io/',
     'licencia': 'CC BY 4.0'},
    {'nombre': 'Have I Been Pwned', 'url': 'https://haveibeenpwned.com/',
     'licencia': 'CC BY 4.0'},
]

UA = 'am-i-exposed.com daily-hack (+https://www.am-i-exposed.com/daily-hack/)'
MODELO = os.environ.get('RADAR_MODELO', 'claude-opus-5-5')
LOTE = 25
# Techo por corrida. Un dia normal trae unas cuarenta victimas nuevas; esto
# solo muerde en la primera corrida, cuando esta pendiente el archivo entero.
MAX_CLASIFICA = 200


def baja(url, timeout=90):
    req = urllib.request.Request(url, headers={'User-Agent': UA,
                                               'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def ident(grupo, victima):
    """Identidad de un caso. El mismo grupo nombrando a la misma victima es el
    mismo caso aunque el rastreador lo vuelva a listar otro dia."""
    semilla = f'{(grupo or "").strip().lower()}|{(victima or "").strip().lower()}'
    return hashlib.sha1(semilla.encode('utf-8')).hexdigest()[:16]


RANSOMLOOK = 'https://www.ransomlook.io'
INDICE_RL = RANSOMLOOK + '/recent'


def enlace_grupo(grupo):
    """La pagina del grupo en RansomLook, donde esa victima esta listada.

    Dos de cada tres posts llegan sin enlace propio, y mandar a quien quiera
    leer mas al indice general de recientes es mandarlo a ninguna parte. La
    pagina del grupo si lleva al caso. Lo que no se hace nunca es enlazar el
    .onion del propio grupo, que es lo que viene en algunos registros: eso es
    el sitio de extorsion, y aqui no se manda a nadie ahi."""
    g = (grupo or '').strip()
    if not g or g == '—':
        return INDICE_RL
    return RANSOMLOOK + '/group/' + urllib.parse.quote(g.lower(), safe='')


def enlace_ransomlook(link, grupo=None):
    """A donde mandamos a quien quiera leer mas sobre un caso.

    Siempre a la pagina del grupo en RansomLook, nunca a lo que trae el campo
    `link` de la API. Ese campo parecia una ruta suya y no lo es: es la ruta
    dentro del sitio del propio grupo criminal (/site/blog?uuid=..., /entity/,
    /project/, /place/...). Pegarle delante ransomlook.io producia enlaces que
    daban 404, y resolverlo tal cual seria enlazar el sitio de extorsion. Se
    comprobaron todas las formas que aparecian en los datos y ninguna existe
    en su web; la unica que responde 200 es /group/<nombre>.

    Ademas de ser lo correcto, esto cierra de raiz el riesgo que senalaba la
    revision de seguridad: ninguna cadena de un tercero llega nunca a un href.
    """
    return enlace_grupo(grupo)


def limpia_victima(titulo):
    """El titulo del post trae la coletilla del grupo. 'acme.com leak incident'
    es la empresa acme.com; publicar la coletilla es publicar su prosa."""
    t = re.sub(r'\s+', ' ', (titulo or '')).strip()
    # La coletilla va delante tanto como detras: "leak #3 acme" y
    # "acme leak incident" son la misma empresa escrita por dos grupos.
    t = re.sub(r'^\s*(\[[^\]]*\]|new|full|part \d+|leaks?(\s*#\s*\d+)?|'
               r'data ?leak)\s*[-|:]?\s*', '', t, flags=re.I)
    t = re.sub(r'\s*[-|:]?\s*(leak|leaks|leaked|data ?leak|leak incident|'
               r'disclosure|published|part \d+)\s*$', '', t, flags=re.I)
    return t.strip(' -|:·').strip()[:140]


DOMINIO = re.compile(
    r'\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\.[a-z]{2})?)\b', re.I)

# Dominios que aparecen en el texto de los grupos y no son de la victima.
RUIDO = {'ransomlook.io', 'haveibeenpwned.com', 'tor.onion', 'protonmail.com',
         'gmail.com', 'outlook.com', 'telegram.org', 'twitter.com', 'x.com'}


def dominio(*textos):
    """El dominio de la victima, si asoma en el titulo o en la descripcion.

    Es la mejor pista de pais que hay: un .pe o un .br dicen de donde es la
    empresa mucho mejor que su nombre, y el clasificador no tiene forma de
    saberlo si no se lo damos. Un .com no dice nada, y eso se lo advertimos
    en la instruccion."""
    for t in textos:
        for m in DOMINIO.finditer(t or ''):
            d = m.group(1).lower().rstrip('.')
            if d not in RUIDO and not d.endswith('.onion'):
                return d
    return ''


# --------------------------------------------------------------------------
# Fuentes

def de_ransomlook(desde):
    posts = baja(f'https://www.ransomlook.io/api/recent/{RECIENTES}')
    salida = []
    for p in posts:
        dia = (p.get('discovered') or '')[:10]
        victima = limpia_victima(p.get('post_title'))
        if not dia or not victima or dia < desde:
            continue
        salida.append({
            'id': ident(p.get('group_name'), victima),
            'day': dia,
            'victim': victima,
            'group': (p.get('group_name') or '').strip() or '—',
            'type': 'ransomware',
            'status': 'reclamado',
            'source': 'RansomLook',
            'sourceUrl': enlace_ransomlook(p.get('link'), p.get('group_name')),
            # Solo para clasificar. No se publica: es texto de otro.
            '_dominio': dominio(victima, p.get('description')),
            '_pista': (p.get('description') or '')[:400],
        })
    return salida


def de_hibp(desde):
    """Las brechas que HIBP agrego en la ventana. Son las unicas filas de la
    pagina que alguien verifico de verdad, y por eso van marcadas aparte."""
    try:
        brechas = baja('https://haveibeenpwned.com/api/v3/breaches')
    except urllib.error.HTTPError as e:
        print(f'HIBP no contesto ({e.code}): se sigue sin esa fuente', file=sys.stderr)
        return []
    salida = []
    for b in brechas:
        dia = (b.get('AddedDate') or '')[:10]
        nombre = (b.get('Title') or b.get('Name') or '').strip()
        if not dia or not nombre or dia < desde:
            continue
        salida.append({
            'id': ident('hibp', nombre),
            'day': dia,
            'victim': nombre,
            'group': '—',
            'type': 'filtracion',
            'status': 'verificado',
            'source': 'Have I Been Pwned',
            'sourceUrl': 'https://haveibeenpwned.com/PwnedWebsites#'
                         + (b.get('Name') or ''),
            '_dominio': (b.get('Domain') or '').lower(),
            '_pista': f"{b.get('PwnCount') or 0} cuentas",
        })
    return salida


# --------------------------------------------------------------------------
# Clasificacion

ESQUEMA = {
    'type': 'object',
    'properties': {
        'items': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'i': {'type': 'integer'},
                    'country': {'type': 'string'},
                    'sector': {'type': 'string', 'enum': sorted(SECTORES)},
                },
                'required': ['i', 'country', 'sector'],
                'additionalProperties': False,
            },
        },
    },
    'required': ['items'],
    'additionalProperties': False,
}

INSTRUCCION = (
    'You are labelling organisations that appear on ransomware leak sites.\n'
    'For each numbered entry return the headquarters country as an ISO 3166-1 '
    'alpha-2 code, and the industry from the allowed list.\n\n'
    'Rules that matter more than coverage:\n'
    '- Return "" for the country when you are not confident which country the '
    'organisation is headquartered in. A wrong country is worse than none: it '
    'puts a company in the wrong section of a public page.\n'
    '- Return "otros" for the industry when you are not confident.\n'
    '- A country-code domain is strong evidence: .pe is Peru, .br Brazil, .mx '
    'Mexico, .co.uk the United Kingdom. Trust it over your own guess about the '
    'name.\n'
    '- A .com, .net or .org domain says nothing about the country. Judge by '
    'what you know of the organisation itself, its name and the hint text.\n'
    '- Never infer the country from the attacking group: these groups hit '
    'victims everywhere.\n'
    '- You are labelling the victim, not the attacker.'
)


def hay_credencial():
    """Si el SDK va a poder autenticarse. Son dos caminos: una clave estatica,
    o identidad federada, que es la que usa el trabajo de GitHub: GitHub firma
    un token de cinco minutos, el SDK lo canjea y no hay secreto guardado en
    ningun lado. Preguntar solo por ANTHROPIC_API_KEY daria un falso negativo
    justo en el camino bueno."""
    if os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('ANTHROPIC_AUTH_TOKEN'):
        return True
    federacion = all(os.environ.get(v) for v in (
        'ANTHROPIC_FEDERATION_RULE_ID',
        'ANTHROPIC_ORGANIZATION_ID',
        'ANTHROPIC_SERVICE_ACCOUNT_ID'))
    token = (os.environ.get('ANTHROPIC_IDENTITY_TOKEN_FILE')
             or os.environ.get('ANTHROPIC_IDENTITY_TOKEN'))
    return bool(federacion and token)


def clasifica(nuevos):
    """Pone pais e industria a los casos nuevos. Falla hacia 'no se sabe'."""
    if not nuevos:
        return
    if not hay_credencial():
        print('sin credencial de Claude: los casos nuevos quedan sin pais ni industria',
              file=sys.stderr)
        return
    try:
        import anthropic
    except ImportError:
        print('falta el paquete anthropic: los casos nuevos quedan sin clasificar',
              file=sys.stderr)
        return

    cliente = anthropic.Anthropic()
    for inicio in range(0, len(nuevos), LOTE):
        lote = nuevos[inicio:inicio + LOTE]
        listado = '\n'.join(
            f'{n}. {c["victim"]}'
            + (f' — domain: {c["_dominio"]}' if c.get('_dominio') else '')
            + (f' — hint: {c["_pista"]}' if c.get('_pista') else '')
            for n, c in enumerate(lote))
        try:
            r = cliente.messages.create(
                model=MODELO,
                max_tokens=4000,
                output_config={'effort': 'low',
                               'format': {'type': 'json_schema', 'schema': ESQUEMA}},
                system=INSTRUCCION,
                messages=[{'role': 'user', 'content': listado}],
            )
            if r.stop_reason == 'refusal':
                print(f'lote {inicio}: el modelo declino, queda sin clasificar',
                      file=sys.stderr)
                continue
            texto = next(b.text for b in r.content if b.type == 'text')
            for fila in json.loads(texto).get('items', []):
                n = fila.get('i')
                if not isinstance(n, int) or not 0 <= n < len(lote):
                    continue
                codigo = (fila.get('country') or '').strip().upper()
                lote[n]['country'] = codigo if codigo in PAISES else ''
                sector = fila.get('sector')
                lote[n]['sector'] = sector if sector in SECTORES else 'otros'
            # Contestada la tanda, queda marcada aunque alguna fila saliera
            # sin pais. Lo que falla arriba no se marca: eso si se reintenta.
            for c in lote:
                c['tried'] = 1
        except Exception as e:                       # noqa: BLE001
            # Una tanda sin clasificar es una pagina con filas sin pais.
            # Una excepcion aqui seria una pagina sin actualizar.
            print(f'lote {inicio}: fallo la clasificacion ({e})', file=sys.stderr)


# --------------------------------------------------------------------------

def main():
    seco = '--dry-run' in sys.argv
    ventana = VENTANA_DIAS
    if '--days' in sys.argv:
        ventana = int(sys.argv[sys.argv.index('--days') + 1])

    hoy = dt.date.today()
    desde = (hoy - dt.timedelta(days=ventana)).isoformat()

    previo = {}
    if os.path.exists(DESTINO):
        for c in json.load(open(DESTINO, encoding='utf-8')).get('items', []):
            previo[c['id']] = c

    crudos = de_ransomlook(desde)
    if not crudos:
        raise SystemExit('RansomLook no devolvio nada: no se escribe el archivo')
    crudos += de_hibp(desde)

    # Un caso que ya paso por el clasificador no se vuelve a preguntar, ni
    # siquiera si volvio sin pais: una empresa que el modelo no reconocio hoy
    # tampoco la va a reconocer manana, y repreguntarla todos los dias es
    # pagar cada manana por la misma respuesta. La marca es `tried`, no el
    # pais: si no, los casos sin identificar serian una cuenta eterna.
    nuevos, items = [], []
    for c in crudos:
        viejo = previo.get(c['id'])
        if viejo:
            c['country'] = viejo.get('country', '')
            c['sector'] = viejo.get('sector', 'otros')
            c['day'] = min(c['day'], viejo['day'])   # la primera vez que se vio
            if not viejo.get('tried'):
                nuevos.append(c)                     # quedo pendiente de otra corrida
            else:
                c['tried'] = 1
        else:
            c['country'] = ''
            c['sector'] = 'otros'
            nuevos.append(c)
        items.append(c)

    # Lo que ya estaba y hoy no vino (RansomLook solo devuelve lo reciente).
    vistos = {c['id'] for c in items}
    for cid, c in previo.items():
        if cid not in vistos and c.get('day', '') >= desde:
            items.append(c)
            if not c.get('tried'):
                nuevos.append(c)

    print(f'{len(items)} casos en la ventana, {len(nuevos)} sin clasificar')
    if not seco:
        # El tope existe para la primera corrida, que llega con el archivo
        # entero pendiente. Lo que no entre hoy entra manana.
        clasifica(nuevos[:MAX_CLASIFICA])
    else:
        print('--dry-run: no se clasifica ni se escribe')

    # Las filas viejas guardaron su identidad con el nombre tal cual venia, y
    # el limpiador de nombres ha cambiado desde entonces: "[DISCLOSED]Hospital
    # X" y "Hospital X" son el mismo hospital con dos identidades distintas, y
    # salian dos veces en la pagina. Se vuelve a limpiar el nombre, se vuelve
    # a calcular la identidad y lo que colisiona se funde, quedandose con la
    # primera fecha y con lo que cada copia supiera.
    fundidos = {}
    for c in items:
        c['victim'] = limpia_victima(c['victim']) or c['victim']
        c['id'] = ident(c.get('group'), c['victim'])
        otro = fundidos.get(c['id'])
        if not otro:
            fundidos[c['id']] = c
            continue
        otro['day'] = min(otro['day'], c['day'])
        for campo in ('country', 'sector', 'sourceUrl'):
            if not otro.get(campo) or otro.get(campo) == 'otros':
                if c.get(campo):
                    otro[campo] = c[campo]
        if c.get('tried'):
            otro['tried'] = 1
    items = list(fundidos.values())

    items.sort(key=lambda c: (c['day'], c['victim']), reverse=True)
    # Lo que sigue en el archivo de corridas viejas no volvio a pasar por
    # enlace_ransomlook. RansomLook devuelve a veces enlaces relativos raros
    # ("topic.php?id=..."), que puestos en un href resolverian contra nuestro
    # propio dominio. Un enlace al indice es menos util y es cierto.
    for c in items:
        c.pop('_pista', None)
        c.pop('_dominio', None)
        hibp = c.get('source') == 'Have I Been Pwned'
        if not c.get('sourceUrl', '').lower().startswith(('http://', 'https://')):
            c['sourceUrl'] = ('https://haveibeenpwned.com/PwnedWebsites' if hibp
                              else enlace_grupo(c.get('group')))
        elif not hibp and not c['sourceUrl'].startswith(RANSOMLOOK + '/group/'):
            # Filas de corridas anteriores: unas apuntaban al indice general y
            # otras a rutas del sitio del grupo que en RansomLook dan 404.
            c['sourceUrl'] = enlace_grupo(c.get('group'))

    salida = {
        'generated': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'window_days': ventana,
        'sources': FUENTES,
        'items': items,
    }
    if seco:
        hoy_iso = hoy.isoformat()
        print(f'hoy ({hoy_iso}): {sum(1 for c in items if c["day"] == hoy_iso)} casos')
        return
    json.dump(salida, open(DESTINO, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    sin_pais = sum(1 for c in items if not c.get('country'))
    print(f'data/radar.json: {len(items)} casos, {sin_pais} sin pais')


if __name__ == '__main__':
    main()
