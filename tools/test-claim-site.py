#!/usr/bin/env python3
"""Comprueba que los dos validadores del sitio de reclamo dicen lo mismo.

Hay dos porque el enlace se escribe en dos sitios: el generador lo mete en
las paginas estaticas, y app.js lo pinta en la tarjeta leyendo un JSON
servido. Dos implementaciones de la misma regla, en dos lenguajes, es una
pareja que se separa sola con el tiempo.

Y ya se habia separado una vez. El de Python limpiaba los signos de los dos
extremos y el de JavaScript solo de la cola, asi que "<evil.com" salia como
un enlace a evil.com en las 486 paginas mientras la tarjeta lo rechazaba. El
lado permisivo era justo el que publica.

Esta prueba corre el mismo corpus por los dos y falla si discrepan en una
sola entrada. Corre en el flujo semanal, antes de generar nada.

Uso: python3 tools/test-claim-site.py
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import _claim_site as claim_site

CORPUS = [
    # los que deben pasar
    'NMGSettlement.com', 'www.ExpDataBreachSettlement.com', 'MGMdataSettlement.com',
    'https://MintedSettlement.com', 'http://ParkMobileSettlement.com',
    'FTC.gov/enforcement/refunds/cafepress-settlement',
    'AlcoholDeliveryDataBreach.com', 'InfinityClassSettlement.com',
    'settlement-site.co.uk', 'a-b.com', 'x.io', 'NMGSettlement.com.',
    # esquemas
    'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>',
    'vbscript:msgbox', 'file:///etc/passwd', 'about:blank', 'blob:https://x.com/1',
    # credenciales, puertos, rarezas de host
    'evil.com@real.com', 'real.com:8080', 'real.com:80/claim', '-mal.com',
    'mal-.com', 'a..b.com', '.com', 'a.b', 'com', 'no-es-un-dominio',
    '192.168.1.1', '127.0.0.1/claim', 'localhost',
    # basura delante y detras
    '<evil.com', '"evil.com', "'evil.com", '(evil.com', '...evil.com',
    '>NMGSettlement.com', 'NMGSettlement.com)', 'NMGSettlement.com,',
    # espacios y control
    'settlement site.com', ' NMGSettlement.com ', 'a\tb.com', 'a\nb.com',
    'a\\b.com', ' NMGSettlement.com',
    # codificacion y consultas
    '%6a%61%76%61script:alert(1)', 'https://x.com/path?a=1', 'x.com/a#b',
    'x.com/ok_path-1.html', 'x.com/%20', 'xn--80ak6aa92e.com',
    # limites
    '', '   ', 'a' * 260 + '.com', 'https://', '//evil.com', '///evil.com',
    'HTTPS://NMGSettlement.com', 'hTTp://x.com',
]

JS_FUNC = re.compile(r'^const CLAIM_HOST.*?^}', re.S | re.M)


def resultados_js(corpus):
    app = open(os.path.join(ROOT, 'app.js'), encoding='utf-8').read()
    m = JS_FUNC.search(app)
    if not m:
        raise SystemExit('no encuentro sitioValido() en app.js')
    script = m.group(0) + '\nconst entrada = JSON.parse(process.argv[1]);\n' \
             'console.log(JSON.stringify(entrada.map(v => sitioValido(v))));'
    out = subprocess.run(['node', '-e', script, json.dumps(corpus)],
                         capture_output=True, text=True)
    if out.returncode:
        raise SystemExit('node fallo:\n' + out.stderr)
    return json.loads(out.stdout)


def main():
    js = resultados_js(CORPUS)
    fallos = []
    for v, r_js in zip(CORPUS, js):
        r_py = claim_site.mostrar(v)        # mostrar() es lo que se publica
        if (r_py or None) != (r_js or None):
            fallos.append((v, r_py, r_js))
    ancho = max(len(repr(v)[:44]) for v in CORPUS)
    for v, r_py, r_js in fallos:
        print(f'DISCREPA {repr(v)[:44]:<{ancho}}  python={r_py!r}  js={r_js!r}')
    print(f'\n{len(CORPUS)} entradas, {len(fallos)} discrepancias')
    aceptadas = sum(1 for v in CORPUS if claim_site.mostrar(v))
    print(f'aceptadas por ambos: {aceptadas}, rechazadas: {len(CORPUS) - aceptadas}')
    if fallos:
        raise SystemExit('los validadores no coinciden')
    print('los dos validadores coinciden')


if __name__ == '__main__':
    main()
