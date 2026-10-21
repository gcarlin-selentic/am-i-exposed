#!/usr/bin/env python3
"""Writes sitemap.xml.

Hand-maintaining this stopped being possible the moment the settlement pages
arrived: there are hundreds of them and they are generated, so the sitemap has
to be generated from the same table or the two drift apart silently.

English is the default language now, so x-default points at the English URL of
every pair. The United States is the only place the alerts can pay out, and a
reader whose language we cannot infer is better served by the version written
for that market.

lastmod is the date the page's content changed, never the date of the deploy:
bumping it on every push teaches the crawler to ignore the field.
"""
import json, os, sys

DOM = 'https://www.am-i-exposed.com'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (ruta_es, ruta_en, lastmod_es, lastmod_en, priority, changefreq)
PAIRS = [
    ('/es/', '/', '2026-09-25', '2026-09-25', '1.0', 'weekly'),
    ('/es/preguntas-frecuentes/', '/faq/', '2026-10-01', '2026-10-01', '0.8', None),
    ('/es/que-hacer-si-se-filtro-mi-correo/', '/what-to-do-if-your-email-was-leaked/',
     '2026-09-25', '2026-09-25', '0.8', None),
    ('/es/como-saber-si-mi-contrasena-fue-filtrada/', '/how-to-know-if-your-password-was-leaked/',
     '2026-09-25', '2026-09-25', '0.8', None),
    ('/es/privacidad/', '/privacy/', '2026-09-25', '2026-09-25', '0.3', None),
    ('/es/aviso-privacidad-eeuu/', '/us-privacy-notice/', '2026-10-09', '2026-10-09', '0.3', None),
    ('/es/terminos/', '/terms/', '2026-09-25', '2026-09-25', '0.3', None),
]

def entry(loc, alts, lastmod, priority, changefreq=None):
    out = ['    <url>', f'        <loc>{DOM}{loc}</loc>']
    for hl, href in alts:
        out.append(f'        <xhtml:link rel="alternate" hreflang="{hl}" href="{DOM}{href}"/>')
    out.append(f'        <lastmod>{lastmod}</lastmod>')
    if changefreq:
        out.append(f'        <changefreq>{changefreq}</changefreq>')
    out.append(f'        <priority>{priority}</priority>')
    out.append('    </url>')
    return '\n'.join(out)

def build():
    urls = []
    for es, en, lm_es, lm_en, pr, cf in PAIRS:
        alts = [('es', es), ('en', en), ('x-default', en)]
        urls.append(entry(en, alts, lm_en, pr, cf))
        urls.append(entry(es, alts, lm_es, pr, cf))

    # El Daily Hack no esta en PAIRS porque su lastmod no es una constante:
    # es el dia de la ultima corrida, que deja escrito build-daily-hack.py.
    # Es la unica pagina del sitio donde changefreq diario es cierto.
    dh = os.path.join(ROOT, 'daily-hack.json')
    if os.path.exists(dh):
        dia = json.load(open(dh, encoding='utf-8'))['date']
        alts = [('es', '/es/daily-hack/'), ('en', '/daily-hack/'),
                ('x-default', '/daily-hack/')]
        urls.append(entry('/daily-hack/', alts, dia, '0.9', 'daily'))
        urls.append(entry('/es/daily-hack/', alts, dia, '0.9', 'daily'))

    # Las paginas de acuerdos, si ya estan generadas. Solo existen en ingles:
    # cubren litigios de Estados Unidos y la suscripcion solo se vende alli.
    idx = os.path.join(ROOT, 'data', 'settlement-pages.json')
    n_cases = 0
    if os.path.exists(idx):
        for p in json.load(open(idx, encoding='utf-8')):
            urls.append(entry(p['ruta'], [], p['lastmod'], p.get('priority', '0.6')))
            n_cases += 1

    head = f'''<?xml version="1.0" encoding="UTF-8"?>
<!--
  Generado por tools/build-sitemap.py. No editar a mano.

  {len(PAIRS)} pares de idioma mas {n_cases} paginas de acuerdos.
  x-default apunta al ingles: es el mercado por defecto del producto.
-->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">

'''
    return head + '\n'.join(urls) + '\n\n</urlset>\n'

if __name__ == '__main__':
    xml = build()
    open(os.path.join(ROOT, 'sitemap.xml'), 'w', encoding='utf-8').write(xml)
    print(f"sitemap.xml: {xml.count('<loc>')} URLs")
