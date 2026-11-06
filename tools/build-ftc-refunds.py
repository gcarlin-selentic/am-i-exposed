#!/usr/bin/env python3
"""Descarga la tabla de programas de reembolso activos de la FTC y la escribe
en ftc-refunds.json.

Por que la FTC y no solo los acuerdos por filtracion: nuestros acuerdos se
cruzan con el correo (la persona aparece en la brecha). Los reembolsos de la
FTC no: se reclaman por haber sido cliente de la empresa sancionada, a traves
del administrador designado. Asi que no alimentan los chips cruzados por
correo; son una lista para explorar ("¿fuiste cliente?"), bajo la misma idea
de "dinero que te pueden deber". Es obra del gobierno de EE.UU., dominio
publico, libre de usar.

Solo biblioteca estandar (urllib + html.parser), como el resto de tools/.

Guarda: si la pagina cambia de forma y se extraen muy pocas filas, falla sin
escribir, para no publicar una lista vacia que borraria la seccion del sitio.
"""
import datetime as dt
import json
import os
import re
import sys
from html.parser import HTMLParser
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUENTE = 'https://www.ftc.gov/enforcement/refunds'
BASE = 'https://www.ftc.gov'
SALIDA = os.path.join(ROOT, 'ftc-refunds.json')

# Debajo de esto, algo cambio en la pagina y lo extraido no es de fiar. La
# tabla ronda las ~60 filas; 20 es un piso amplio que aun delata un fallo.
MINIMO = 20

MESES = {m: i for i, m in enumerate(
    ['january', 'february', 'march', 'april', 'may', 'june', 'july',
     'august', 'september', 'october', 'november', 'december'], 1)}


class TablaReembolsos(HTMLParser):
    """Recoge las filas de la primera tabla cuyas celdas enlazan a
    /enforcement/refunds/<algo>: esa es la de programas activos."""

    def __init__(self):
        super().__init__()
        self.en_tabla = False
        self.en_fila = False
        self.en_celda = False
        self.celda_texto = []
        self.celda_href = None
        self.fila = []
        self.filas = []

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.en_tabla = True
        elif tag == 'tr' and self.en_tabla:
            self.en_fila = True
            self.fila = []
        elif tag in ('td', 'th') and self.en_fila:
            self.en_celda = True
            self.celda_texto = []
            self.celda_href = None
        elif tag == 'a' and self.en_celda and self.celda_href is None:
            href = dict(attrs).get('href') or ''
            if '/enforcement/refunds/' in href:
                self.celda_href = href

    def handle_endtag(self, tag):
        if tag == 'table':
            self.en_tabla = False
        elif tag == 'tr' and self.en_fila:
            self.en_fila = False
            if self.fila:
                self.filas.append(self.fila)
        elif tag in ('td', 'th') and self.en_celda:
            self.en_celda = False
            texto = re.sub(r'\s+', ' ', ''.join(self.celda_texto)).strip()
            self.fila.append({'texto': texto, 'href': self.celda_href})

    def handle_data(self, data):
        if self.en_celda:
            self.celda_texto.append(data)


def parse_fecha(texto):
    """'November 2026' -> '2026-11' para ordenar. Devuelve None si no encaja."""
    m = re.search(r'([A-Za-z]+)\s+(\d{4})', texto or '')
    if not m:
        return None
    mes = MESES.get(m.group(1).lower())
    if not mes:
        return None
    return f'{m.group(2)}-{mes:02d}'


def parse_contacto(texto):
    """'1-888-691-6050 Epiq Systems' -> (telefono, administrador)."""
    if not texto:
        return (None, None)
    tels = re.findall(r'(?:\+?1[-\s]?)?(?:\d{3}[-\s]?){2}\d{4}', texto)
    telefono = tels[0].strip() if tels else None
    resto = texto
    for t in tels:
        resto = resto.replace(t, ' ')
    # 'or +1-612-...' deja un 'or' suelto; se limpia.
    admin = re.sub(r'\bor\b', ' ', resto)
    admin = re.sub(r'\s+', ' ', admin).strip(' -·,')
    return (telefono, admin or None)


def descargar(url):
    req = Request(url, headers={'User-Agent': 'am-i-exposed-refunds-bot/1.0'})
    with urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', 'replace')


def main():
    dry = '--dry-run' in sys.argv
    html_doc = descargar(FUENTE)
    p = TablaReembolsos()
    p.feed(html_doc)

    programas = []
    vistos = set()
    for fila in p.filas:
        # La fila valida tiene una celda con enlace a /enforcement/refunds/.
        celda_nombre = next((c for c in fila if c['href']), None)
        if not celda_nombre:
            continue
        href = celda_nombre['href']
        if href in vistos:
            continue
        vistos.add(href)

        nombre = celda_nombre['texto']
        # 'Razer Refunds Products: Zephyr face masks' -> separa los productos.
        productos = None
        m = re.search(r'Products:\s*(.+)$', nombre)
        if m:
            productos = m.group(1).strip()
            nombre = nombre[:m.start()].strip()

        otras = [c['texto'] for c in fila if c is not celda_nombre]
        fecha_txt = next((t for t in otras if parse_fecha(t)), '')
        contacto_txt = next((t for t in otras
                             if t and t is not fecha_txt and
                             re.search(r'\d', t)), '')
        telefono, admin = parse_contacto(contacto_txt)

        programas.append({
            'name': nombre,
            'url': BASE + href if href.startswith('/') else href,
            'products': productos,
            'date': fecha_txt.strip() or None,
            'date_sort': parse_fecha(fecha_txt),
            'administrator': admin,
            'phone': telefono,
        })

    if len(programas) < MINIMO:
        sys.exit(f'solo {len(programas)} programas extraidos (< {MINIMO}): '
                 f'la pagina de la FTC cambio de forma, no se escribe')

    programas.sort(key=lambda x: x['date_sort'] or '', reverse=True)
    salida = {
        'source': FUENTE,
        'generated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'count': len(programas),
        'programs': programas,
    }

    if dry:
        print(f'{len(programas)} programas (dry-run, no se escribe)')
        for pr in programas[:5]:
            print(f"  {pr['date']:<15} {pr['name']}")
        return

    with open(SALIDA, 'w', encoding='utf-8') as f:
        json.dump(salida, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'ftc-refunds.json: {len(programas)} programas activos')


if __name__ == '__main__':
    main()
