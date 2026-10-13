#!/usr/bin/env python3
"""Writes one indexable page per data breach case, under /settlements/.

Why these pages exist. The free check competes with Have I Been Pwned, which
is also where our breach data comes from: there is no winning that query. What
nobody writes down in one place is the other half, which is the half with money
in it: a company lost your data, a court made it pay, and the claim window is
open or it is not. People search for that by company name, with intent and with
a deadline on them.

English only, on purpose. These are United States lawsuits, the subscription is
sold only there, and the U.S. privacy notice is the one that covers it. A
Spanish page about a Delaware settlement would be a page nobody can act on.

What is NOT published. The 1,036 cases whose investigation closed with no
action: a page saying "a law firm looked and stopped looking" gives the reader
nothing to do and would bury the pages that do. They stay in the data for the
alert matching, out of the sitemap.

Three rules this file will not break, because they are the difference between
a useful page and a liability:

  1. A passed deadline is stated as passed, in the same sentence as the money.
     Never a nudge to claim something that closed.
  2. Appearing in a breach is not class membership, and the page says so on
     every single case, not in a footer nobody reads.
  3. The claim link points at the court-appointed administrator's own site,
     never at us, and never at an affiliate. If we do not have it, we say so
     instead of linking to a search.

Run: python3 tools/build-settlement-pages.py
Then: python3 tools/build-sitemap.py
"""
import json, os, re, html, datetime, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOM = 'https://www.am-i-exposed.com'
OUT = os.path.join(ROOT, 'settlements')
HOY = datetime.date.today()

STOP = {'inc', 'llc', 'llp', 'co', 'corp', 'corporation', 'company', 'ltd', 'lp',
        'pllc', 'pc', 'the', 'and', 'of'}


def slugify(s):
    s = re.sub(r'[^a-z0-9]+', '-', (s or '').lower())
    return re.sub(r'-+', '-', s).strip('-')


def core(s):
    return tuple(w for w in re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).split()
                 if w not in STOP and len(w) > 2)


def money(n):
    if not n:
        return None
    n = int(n)
    if n >= 1_000_000 and n % 100_000 == 0:
        v = n / 1_000_000
        return f"${v:.1f}".rstrip('0').rstrip('.') + ' million'
    return '$' + f"{n:,}"


def fecha_larga(d):
    try:
        return datetime.date.fromisoformat(d).strftime('%B %-d, %Y')
    except Exception:
        return d


def e(s):
    return html.escape(s or '', quote=True)


def parrafos(txt, limite=4):
    """The source descriptions arrive as one block. Split on sentence runs so
    the page reads as prose instead of a wall."""
    txt = re.sub(r'\s+', ' ', (txt or '')).strip()
    if not txt:
        return []
    frases = re.split(r'(?<=[.!?])\s+(?=[A-Z])', txt)
    out, buf = [], ''
    for f in frases:
        buf = (buf + ' ' + f).strip()
        if len(buf) > 320:
            out.append(buf)
            buf = ''
        if len(out) >= limite:
            break
    if buf and len(out) < limite:
        out.append(buf)
    return out


# ---------------------------------------------------------------- datos
tca = json.load(open(os.path.join(ROOT, 'data', 'tca-settlements.json'), encoding='utf-8'))
cao = json.load(open(os.path.join(ROOT, 'data', 'cao-lawsuits.json'), encoding='utf-8'))
matched = json.load(open(os.path.join(ROOT, 'data', 'hibp-matched.json'), encoding='utf-8'))

# nombre-maquina de HIBP por nucleo de nombre, para enlazar el chequeo gratuito
hibp_por_core = {}
for m in matched:
    if m.get('dudoso'):
        continue
    hibp_por_core[core(m['empresa'])] = m

paginas = {}

# 1. acuerdos: hay dinero, plazo y administrador
for r in tca:
    emp = (r.get('empresa') or '').strip()
    if not emp:
        continue
    s = slugify(emp)
    prev = paginas.get(s)
    # Cuando una empresa tiene dos acuerdos, gana el que trae mas que decir.
    peso = (bool(r.get('sitio_oficial')), bool(r.get('fecha_limite')),
            r.get('fondo') or 0, r.get('pago_max_persona') or 0)
    if prev and prev['_peso'] >= peso:
        continue
    paginas[s] = {
        '_peso': peso, 'tipo': 'acuerdo', 'slug': s, 'empresa': emp,
        'fondo': r.get('fondo'), 'pago': r.get('pago_max_persona'),
        'premio': r.get('premio'), 'elegible': r.get('elegible'),
        'plazo': r.get('fecha_limite'), 'audiencia': r.get('audiencia_final'),
        'sitio': r.get('sitio_oficial'), 'caso': r.get('caso'),
        'fuente': r.get('url'), 'fuente_nombre': 'Top Class Actions',
        'datos': None, 'estado_sede': None, 'desc': None,
    }

# 2. demandas vivas: sin dinero todavia, pero con urgencia y con hechos
for r in cao:
    if r.get('estado_caso') not in ('investigacion abierta', 'acuerdo', 'demanda presentada'):
        continue
    emp = (r.get('empresa') or '').strip()
    if not emp:
        continue
    s = slugify(emp)
    if s in paginas and paginas[s]['tipo'] == 'acuerdo':
        # El acuerdo manda, pero el caso aporta que datos se filtraron y los
        # hechos del expediente.
        paginas[s]['datos'] = paginas[s]['datos'] or r.get('datos')
        paginas[s]['estado_sede'] = paginas[s]['estado_sede'] or r.get('estado_sede')
        paginas[s]['fecha'] = paginas[s].get('fecha') or r.get('fecha')
        paginas[s]['publicado'] = paginas[s].get('publicado') or r.get('publicado')
        paginas[s]['afectados'] = paginas[s].get('afectados') or r.get('afectados')
        paginas[s]['nacional'] = paginas[s].get('nacional') or r.get('nacional')
        paginas[s]['estados_notificados'] = (paginas[s].get('estados_notificados')
                                             or r.get('estados_notificados') or [])
        paginas[s]['fuente_cao'] = r.get('url')
        continue
    if s in paginas:
        continue
    paginas[s] = {
        '_peso': (False, False, 0, 0), 'tipo': r['estado_caso'], 'slug': s, 'empresa': emp,
        'fondo': r.get('fondo_acuerdo'), 'pago': r.get('pago_por_persona'),
        'premio': None, 'elegible': None, 'plazo': None, 'audiencia': None,
        'sitio': None, 'caso': r.get('titular'), 'fuente': r.get('url'),
        'fuente_nombre': 'ClassAction.org', 'datos': r.get('datos'),
        'estado_sede': r.get('estado_sede'), 'desc': r.get('desc'),
        'fecha': r.get('fecha'), 'publicado': r.get('publicado'),
        'afectados': r.get('afectados'), 'nacional': r.get('nacional'),
        'estados_notificados': r.get('estados_notificados') or [],
    }

for p in paginas.values():
    p['hibp'] = hibp_por_core.get(core(p['empresa']))

CAVEAT = ('Being in the breach is not the same as being in the class. Class membership '
          'usually turns on having received the company&rsquo;s own notice letter, and only '
          'the settlement administrator can confirm it. We are not lawyers, we take no fee '
          'from any claim, and we never file on anyone&rsquo;s behalf.')


def render(p):
    emp = p['empresa']
    es_acuerdo = p['tipo'] == 'acuerdo'
    url = f"{DOM}/settlements/{p['slug']}/"
    fondo, pago = money(p['fondo']), money(p['pago'])

    plazo_pasado = None
    if p['plazo']:
        try:
            plazo_pasado = datetime.date.fromisoformat(p['plazo']) < HOY
        except Exception:
            plazo_pasado = None

    if es_acuerdo:
        h1 = f"{emp} data breach settlement"
        title = f"{emp} data breach settlement | Am I Exposed?"
    else:
        h1 = f"{emp} data breach lawsuit"
        title = f"{emp} data breach lawsuit | Am I Exposed?"

    # ---- descripcion: hechos, no adjetivos
    d = []
    if pago:
        d.append(f"Paid up to {pago} per person")
    elif fondo:
        d.append(f"A {fondo} fund")
    if p['plazo']:
        d.append('claims closed ' + fecha_larga(p['plazo']) if plazo_pasado
                 else 'claims close ' + fecha_larga(p['plazo']))
    if not d:
        d.append('A data breach lawsuit against ' + emp)
    desc = '. '.join(d) + '. Who was covered, what was exposed, and where the official claim site is.'
    desc = desc[:300]

    # ---- cuerpo
    b = []
    pasado_txt = ''
    if plazo_pasado is True:
        pasado_txt = (f' The claim window <strong>closed on {fecha_larga(p["plazo"])}</strong>, '
                      f'so this one can no longer be claimed.')
    elif plazo_pasado is False:
        pasado_txt = (f' Claims are accepted until <strong>{fecha_larga(p["plazo"])}</strong>.')

    if es_acuerdo:
        if pago and fondo:
            lede = (f'{emp} settled a data breach claim for {fondo}, with up to '
                    f'<strong>{pago} per person</strong>.{pasado_txt}')
        elif pago:
            lede = (f'{emp} settled a data breach claim that paid up to '
                    f'<strong>{pago} per person</strong>.{pasado_txt}')
        elif fondo:
            lede = f'{emp} settled a data breach claim for <strong>{fondo}</strong>.{pasado_txt}'
        else:
            lede = f'{emp} settled a data breach claim.{pasado_txt}'
    else:
        vivo = p['tipo'] == 'investigacion abierta'
        cuando = f" after the breach reported in {p['fecha']}" if p.get('fecha') else ''
        lede = (f'Lawyers are {"currently investigating" if vivo else "pursuing"} claims '
                f'against {emp}{cuando}. No settlement has been announced, so there is '
                f'nothing to claim yet.')
    b.append(f'    <p class="standfirst">{lede}</p>')

    # el dinero, en tabla, porque es lo que se viene a buscar
    filas = []
    if fondo:
        filas.append(('Settlement fund', fondo))
    if pago:
        filas.append(('Maximum per person', pago))
    if p['premio']:
        filas.append(('What it covered', e(re.sub(r'\s+', ' ', p['premio']).strip())))
    if p['plazo']:
        etiqueta = 'Claim deadline (passed)' if plazo_pasado else 'Claim deadline'
        filas.append((etiqueta, fecha_larga(p['plazo'])))
    if p['audiencia']:
        filas.append(('Final approval hearing', fecha_larga(p['audiencia'])))
    if p['caso']:
        filas.append(('Case', e(re.sub(r'\s+', ' ', p['caso']).strip()[:160])))
    if p['estado_sede']:
        filas.append(('Filed in', e(p['estado_sede'])))
    if filas:
        b.append('\n    <h2>The numbers</h2>\n    <table class="facts">\n        <tbody>')
        for k, v in filas:
            b.append(f'            <tr><th scope="row">{k}</th><td>{v}</td></tr>')
        b.append('        </tbody>\n    </table>')

    if p['elegible']:
        b.append('\n    <h2>Who was covered</h2>')
        b.append(f'    <p>{e(re.sub(r"\\s+", " ", p["elegible"]).strip())}</p>')

    if p['datos']:
        # La fuente entrega esto a veces como lista y a veces como una cadena
        # separada por comas, segun el caso.
        crudo = p['datos']
        if isinstance(crudo, (list, tuple)):
            datos = [str(x).strip() for x in crudo if str(x).strip()]
        else:
            datos = [x.strip() for x in re.split(r'[,;]', str(crudo)) if x.strip()]
        if datos:
            b.append('\n    <h2>What was exposed</h2>\n    <ul class="exposed">')
            for x in datos[:12]:
                b.append(f'        <li>{e(x)}</li>')
            b.append('    </ul>')

    # Prosa propia, armada de los campos. La descripcion de la fuente no se
    # reproduce: es su texto editorial, trae su propia llamada a registrarse
    # en su formulario, y copiarla seria publicar contenido duplicado que
    # ademas manda al lector al embudo de otro.
    hechos = []
    if p.get('fecha'):
        hechos.append(f'The incident is recorded as {e(p["fecha"])}')
    if p.get('afectados'):
        try:
            hechos.append(f'about {int(p["afectados"]):,} people were affected')
        except Exception:
            pass
    if p.get('estado_sede'):
        hechos.append(f'the company is based in {e(p["estado_sede"])}')
    n_est = len(p.get('estados_notificados') or [])
    if p.get('nacional'):
        hechos.append('the breach was reported nationally')
    elif n_est:
        hechos.append(f'notice went to attorneys general in {n_est} '
                      f'{"state" if n_est == 1 else "states"}')
    if hechos:
        frase = hechos[0] + (', and ' + hechos[-1] if len(hechos) > 1 else '')
        if len(hechos) > 2:
            frase = ', '.join(hechos[:-1]) + ', and ' + hechos[-1]
        b.append(f'\n    <h2>What is on the record</h2>\n    <p>{frase}.</p>')
    if p.get('publicado'):
        estado_txt = {
            'investigacion abierta': 'Lawyers were still taking claims at that point.',
            'acuerdo': 'A settlement followed.',
            'demanda presentada': 'A complaint had been filed.',
        }.get(p['tipo'], '')
        b.append(f'    <p>The case was first listed on {e(p["publicado"])}. {estado_txt}</p>')

    # el enlace de reclamo: la razon por la que esta pagina sirve
    b.append('\n    <h2>Where to claim</h2>')
    if p['sitio']:
        sitio = p['sitio'].strip()
        href = sitio if sitio.startswith('http') else 'https://' + sitio.lstrip('/')
        if plazo_pasado is True:
            b.append(f'    <p>The administrator&rsquo;s site is '
                     f'<a href="{e(href)}" rel="nofollow noopener">{e(sitio)}</a>. '
                     f'The window is closed, so it is there for the record, not to file.</p>')
        else:
            b.append(f'    <p>Claims go through the court-appointed administrator, at '
                     f'<a href="{e(href)}" rel="nofollow noopener">{e(sitio)}</a>. '
                     f'That is the only place a claim counts. Nobody should ever charge '
                     f'you to file one.</p>')
    else:
        b.append('    <p>We do not have an administrator&rsquo;s site on record for this '
                 'one. The case page below is the primary source we used, and any claim '
                 'site would be named there.</p>')
    b.append(f'    <p class="source">Source: <a href="{e(p["fuente"])}" '
             f'rel="nofollow noopener">{p["fuente_nombre"]}</a>'
             + (f' &middot; <a href="{e(p["fuente_cao"])}" rel="nofollow noopener">ClassAction.org</a>'
                if p.get('fuente_cao') else '') + '</p>')

    b.append(f'\n    <div class="note">\n        <p>{CAVEAT}</p>\n    </div>')

    # el puente al chequeo gratuito, solo cuando es verdad
    if p['hibp']:
        m = p['hibp']
        b.append(f'\n    <div class="cta">\n        <h2>Was your address in this breach?</h2>'
                 f'\n        <p>This one is in the breach data we check against: '
                 f'{int(m["cuentas"]):,} accounts. The check is free, takes seconds, '
                 f'needs no account, and we do not store your address.</p>'
                 f'\n        <a class="cta-btn" href="/">Check my email</a>\n    </div>')
    else:
        b.append('\n    <div class="cta">\n        <h2>Check your own exposure</h2>'
                 '\n        <p>Free, no account, and we do not store your address. '
                 'If a company that leaked your data ends up paying, that is how '
                 'you find out in time.</p>'
                 '\n        <a class="cta-btn" href="/">Check my email</a>\n    </div>')

    cuerpo = '\n'.join(b)

    ld = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "Article", "headline": h1, "description": desc,
             "inLanguage": "en", "url": url, "mainEntityOfPage": url,
             "about": {"@type": "Organization", "name": emp},
             "isPartOf": {"@type": "CollectionPage",
                          "name": "Data breach settlements",
                          "url": f"{DOM}/settlements/"}},
            {"@type": "BreadcrumbList", "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": DOM + '/'},
                {"@type": "ListItem", "position": 2, "name": "Settlements",
                 "item": f"{DOM}/settlements/"},
                {"@type": "ListItem", "position": 3, "name": emp, "item": url},
            ]},
        ],
    }

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>{e(title)}</title>
    <meta name="description" content="{e(desc)}">
    <meta name="robots" content="index, follow">
    <meta name="theme-color" content="#FAFAFA">

    <link rel="canonical" href="{url}">

    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Am I Exposed?">
    <meta property="og:locale" content="en_US">
    <meta property="og:title" content="{e(h1)}">
    <meta property="og:description" content="{e(desc)}">
    <meta property="og:url" content="{url}">

    <link rel="icon" href="/icon.svg" type="image/svg+xml">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/content.css">

    <script type="application/ld+json">
{json.dumps(ld, indent=4, ensure_ascii=False)}
    </script>
</head>
<body>

<header class="site-head">
    <div class="wrap">
        <a class="brand" href="/">
            <img src="/icon.svg" alt="" width="26" height="26">
            Am I Exposed?
        </a>
        <nav class="head-links">
            <a href="/settlements/">All settlements</a>
            <a href="/">Check my email</a>
        </nav>
    </div>
</header>

<main class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
        <a href="/">Home</a> &rsaquo; <a href="/settlements/">Settlements</a> &rsaquo;
        <span aria-current="page">{e(emp)}</span>
    </nav>

    <h1>{e(h1)}</h1>
{cuerpo}
</main>

<footer class="site-foot">
    <div class="wrap">
        <ul class="foot-links">
            <li><a href="/">Home</a></li>
            <li><a href="/settlements/">Settlements</a></li>
            <li><a href="/faq/">FAQ</a></li>
            <li><a href="/what-to-do-if-your-email-was-leaked/">If your email leaked</a></li>
            <li><a href="/privacy/">Privacy</a></li>
            <li><a href="/us-privacy-notice/">U.S. privacy</a></li>
            <li><a href="/terms/">Terms</a></li>
        </ul>
        <p>Selentic Group &middot; Breach data by
        <a href="https://haveibeenpwned.com" rel="noopener">Have I Been Pwned</a></p>
    </div>
</footer>

<script>window.va = window.va || function () {{ (window.vaq = window.vaq || []).push(arguments); }};</script>
<script defer src="/_vercel/insights/script.js"></script>

</body>
</html>
'''


# ---------------------------------------------------------------- escritura
if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)

indice = []
orden = sorted(paginas.values(),
               key=lambda p: (p['tipo'] != 'acuerdo', -(p['pago'] or 0), -(p['fondo'] or 0),
                              p['empresa'].lower()))
for p in orden:
    d = os.path.join(OUT, p['slug'])
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'index.html'), 'w', encoding='utf-8').write(render(p))
    abierto = False
    if p['plazo']:
        try:
            abierto = datetime.date.fromisoformat(p['plazo']) >= HOY
        except Exception:
            pass
    indice.append({
        'ruta': f"/settlements/{p['slug']}/", 'empresa': p['empresa'], 'tipo': p['tipo'],
        'fondo': p['fondo'], 'pago': p['pago'], 'plazo': p['plazo'], 'abierto': abierto,
        'sitio': p['sitio'], 'en_hibp': bool(p['hibp']),
        'lastmod': HOY.isoformat(),
        'priority': '0.7' if (p['tipo'] == 'acuerdo' or abierto) else '0.5',
    })


# ---------------------------------------------------------------- indice
# Mil setenta y cinco enlaces en una sola pagina no es un indice, es un
# vertedero: el rastreador reparte el peso entre todos y ninguno recibe nada.
# Asi que el indice es un cubo con los que importan, y de ahi se baja por
# letra, unas cuarenta por pagina.
SHELL = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>{title}</title>
    <meta name="description" content="{desc}">
    <meta name="robots" content="index, follow">
    <meta name="theme-color" content="#FAFAFA">

    <link rel="canonical" href="{url}">

    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Am I Exposed?">
    <meta property="og:locale" content="en_US">
    <meta property="og:title" content="{h1}">
    <meta property="og:description" content="{desc}">
    <meta property="og:url" content="{url}">

    <link rel="icon" href="/icon.svg" type="image/svg+xml">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/content.css">
{ld}
</head>
<body>

<header class="site-head">
    <div class="wrap">
        <a class="brand" href="/">
            <img src="/icon.svg" alt="" width="26" height="26">
            Am I Exposed?
        </a>
        <nav class="head-links">
            <a href="/settlements/">All settlements</a>
            <a href="/">Check my email</a>
        </nav>
    </div>
</header>

<main class="wrap">
{body}
</main>

<footer class="site-foot">
    <div class="wrap">
        <ul class="foot-links">
            <li><a href="/">Home</a></li>
            <li><a href="/settlements/">Settlements</a></li>
            <li><a href="/faq/">FAQ</a></li>
            <li><a href="/what-to-do-if-your-email-was-leaked/">If your email leaked</a></li>
            <li><a href="/privacy/">Privacy</a></li>
            <li><a href="/us-privacy-notice/">U.S. privacy</a></li>
            <li><a href="/terms/">Terms</a></li>
        </ul>
        <p>Selentic Group &middot; Breach data by
        <a href="https://haveibeenpwned.com" rel="noopener">Have I Been Pwned</a></p>
    </div>
</footer>

<script>window.va = window.va || function () {{ (window.vaq = window.vaq || []).push(arguments); }};</script>
<script defer src="/_vercel/insights/script.js"></script>

</body>
</html>
'''


def fila_html(i):
    if i['pago']:
        monto, nota = money(i['pago']), 'per person'
    elif i['fondo']:
        monto, nota = money(i['fondo']), 'total fund'
    else:
        monto = None
        nota = ('being investigated' if i['tipo'] == 'investigacion abierta'
                else 'in litigation')
    if i['plazo']:
        nota = 'closed ' + fecha_larga(i['plazo'])
    tag = ' <span class="settle-tag">in our check</span>' if i['en_hibp'] else ''
    amt = f'<span class="settle-amount">{monto}</span>' if monto else ''
    return (f'            <li><a href="{i["ruta"]}">'
            f'<span class="settle-name">{e(i["empresa"])}{tag}</span>'
            f'{amt}<span class="settle-when">{nota}</span></a></li>')


letras = {}
for i in indice:
    c = i['empresa'][:1].lower()
    letras.setdefault(c if c.isalpha() else '0', []).append(i)
claves = sorted(letras)


def nav_letras(actual=None):
    out = ['    <nav class="settle-filters" aria-label="By company name">']
    for c in claves:
        etiqueta = '0&ndash;9' if c == '0' else c.upper()
        if c == actual:
            out.append(f'        <a href="/settlements/letter-{c}/" aria-current="page">{etiqueta}</a>')
        else:
            out.append(f'        <a href="/settlements/letter-{c}/">{etiqueta}</a>')
    out.append('    </nav>')
    return '\n'.join(out)


con_pago = sorted([i for i in indice if i['pago']], key=lambda i: -i['pago'])[:50]
vivas = [i for i in indice if i['tipo'] == 'investigacion abierta'][:40]
n_sitio = sum(1 for i in indice if i['sitio'])
n_ac = sum(1 for i in indice if i['tipo'] == 'acuerdo')
n_casos = len(indice)

hub_body = f'''    <h1>Data breach settlements and lawsuits</h1>
    <p class="standfirst">{len(indice):,} cases: {n_ac:,} that reached a settlement and
    {len(indice) - n_ac:,} still in court. Who was covered, how much was paid, and the
    administrator&rsquo;s own claim site where one exists.</p>

    <p>When a company loses your data, what often follows is not a fine but a settlement,
    paid to the people whose data it was. The money is real and most of it goes unclaimed,
    because the notice arrives by post and looks like junk mail. Research out of Duke
    puts claim rates routinely below 10 percent and often far below 1 percent.</p>

    <div class="note">
        <p>{CAVEAT}</p>
    </div>

    <h2>The largest payouts per person</h2>
    <ul class="settle-list">
{chr(10).join(fila_html(i) for i in con_pago)}
    </ul>

    <h2>Cases in court now</h2>
    <p>No settlement has been announced in these, so there is nothing to claim yet. They
    are here because this is the stage at which it is worth knowing your data is involved.</p>
    <ul class="settle-list">
{chr(10).join(fila_html(i) for i in vivas)}
    </ul>

    <h2>Every company, A to Z</h2>
{nav_letras()}

    <div class="cta">
        <h2>Find out which of these touched you</h2>
        <p>The free check tells you which breaches hold your address. Free, no account,
        and we do not store it.</p>
        <a class="cta-btn" href="/">Check my email</a>
    </div>'''

hub_ld = '''
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "Data breach settlements and lawsuits",
        "description": "United States data breach settlements and lawsuits, with amounts, claim deadlines and official claim sites.",
        "inLanguage": "en",
        "url": "''' + DOM + '''/settlements/"
    }
    </script>'''

open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(SHELL.format(
    title='Data breach settlements: who paid and how much | Am I Exposed?',
    desc=f'{len(indice):,} United States data breach cases: settlement amounts, claim '
         f'deadlines and the official claim site for each one.',
    h1='Data breach settlements and lawsuits',
    url=f'{DOM}/settlements/', ld=hub_ld, body=hub_body))

for c in claves:
    filas = sorted(letras[c], key=lambda i: i['empresa'].lower())
    etiqueta = '0&ndash;9' if c == '0' else c.upper()
    plano = '0-9' if c == '0' else c.upper()
    body = f'''    <nav class="crumbs" aria-label="Breadcrumb">
        <a href="/">Home</a> &rsaquo; <a href="/settlements/">Settlements</a> &rsaquo;
        <span aria-current="page">{etiqueta}</span>
    </nav>

    <h1>Data breach cases: companies starting with {etiqueta}</h1>
    <p class="standfirst">{len(filas):,} {'case' if len(filas) == 1 else 'cases'}.
    Amounts are what the settlement paid at most per person, or the size of the fund
    when no per-person figure was published.</p>

{nav_letras(c)}

    <ul class="settle-list">
{chr(10).join(fila_html(i) for i in filas)}
    </ul>

    <div class="cta">
        <h2>Check your own exposure</h2>
        <p>Free, no account, and we do not store your address.</p>
        <a class="cta-btn" href="/">Check my email</a>
    </div>'''
    d = os.path.join(OUT, f'letter-{c}')
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'index.html'), 'w', encoding='utf-8').write(SHELL.format(
        title=f'Data breach cases: companies starting with {plano} | Am I Exposed?',
        desc=f'{len(filas)} United States data breach settlements and lawsuits against '
             f'companies whose name starts with {plano}, with amounts and deadlines.',
        h1=f'Data breach cases: companies starting with {plano}',
        url=f'{DOM}/settlements/letter-{c}/', ld='', body=body))

indice.append({'ruta': '/settlements/', 'empresa': 'index', 'tipo': 'indice',
               'fondo': None, 'pago': None, 'plazo': None, 'abierto': False,
               'sitio': None, 'en_hibp': False,
               'lastmod': HOY.isoformat(), 'priority': '0.9'})
for c in claves:
    indice.append({'ruta': f'/settlements/letter-{c}/', 'empresa': f'index {c}',
                   'tipo': 'indice', 'fondo': None, 'pago': None, 'plazo': None,
                   'abierto': False, 'sitio': None, 'en_hibp': False,
                   'lastmod': HOY.isoformat(), 'priority': '0.4'})

json.dump(indice, open(os.path.join(ROOT, 'data', 'settlement-pages.json'), 'w',
                       encoding='utf-8'), ensure_ascii=False, indent=1)


print(f"paginas de caso       {n_casos}")
print(f"  acuerdos            {n_ac}")
print(f"  demandas vivas      {n_casos - n_ac}")
print(f"paginas de indice     {len(indice) - n_casos}")
print(f"  con plazo abierto   {sum(1 for i in indice if i['abierto'])}")
print(f"  con sitio de reclamo{sum(1 for i in indice if i['sitio']):>4}")
print(f"  cruzadas con HIBP   {sum(1 for i in indice if i['en_hibp'])}")
