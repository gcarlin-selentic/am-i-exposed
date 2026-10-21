#!/usr/bin/env python3
"""Avisa a los buscadores de las URLs que cambiaron, con IndexNow.

Google no usa IndexNow, pero Bing, Yandex, Seznam y Naver si, y Bing es el
indice detras de la busqueda de ChatGPT y de Copilot. Para un sitio que acaba
de publicar mil paginas nuevas eso es la diferencia entre semanas y dias.

Google se entera por el sitemap y por Search Console, que son otra via.

Uso: python3 tools/ping-indexnow.py [--todas]
Sin argumentos manda solo el indice y las paginas de letra, que es lo que
cambia cada semana. Con --todas manda el sitemap entero, que es para el
primer envio.
"""
import json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST = 'www.am-i-exposed.com'

# La clave ya existia, de b316d94. Va escrita aqui y no deducida del nombre de
# un archivo suelto: adivinarla por el patron del nombre es como terminas
# firmando los envios con una clave que no es la que esta publicada.
CLAVE = 'ce8d03c1161d9c042441e151e46d9fec'
clave = CLAVE
if not os.path.exists(os.path.join(ROOT, f'{CLAVE}.txt')):
    raise SystemExit(f'falta {CLAVE}.txt en la raiz: sin el, los envios se rechazan')

# El Daily Hack cambia todos los dias y es lo unico del sitio que caduca en
# horas, asi que va solo: mandar las mil paginas de acuerdos cada manana es
# ensenarle al buscador a ignorar el aviso.
if '--daily-hack' in sys.argv:
    urls = [f'https://{HOST}/daily-hack/', f'https://{HOST}/es/daily-hack/']
else:
    paginas = json.load(open(os.path.join(ROOT, 'data', 'settlement-pages.json'),
                             encoding='utf-8'))
    if '--todas' in sys.argv:
        urls = [f'https://{HOST}{p["ruta"]}' for p in paginas]
        urls += [f'https://{HOST}/', f'https://{HOST}/es/', f'https://{HOST}/faq/']
    else:
        urls = [f'https://{HOST}{p["ruta"]}' for p in paginas if p['tipo'] == 'indice']

# El limite del protocolo son 10.000 por envio.
for i in range(0, len(urls), 10000):
    lote = urls[i:i + 10000]
    cuerpo = json.dumps({'host': HOST, 'key': clave,
                         'keyLocation': f'https://{HOST}/{clave}.txt',
                         'urlList': lote}).encode()
    req = urllib.request.Request('https://api.indexnow.org/IndexNow', data=cuerpo,
                                 headers={'Content-Type': 'application/json; charset=utf-8'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print(f'lote de {len(lote)}: HTTP {r.status}')
    except Exception as e:
        print(f'lote de {len(lote)}: fallo {e}', file=sys.stderr)
