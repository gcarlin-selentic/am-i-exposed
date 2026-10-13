#!/usr/bin/env python3
"""Valida el sitio de reclamo antes de que se convierta en un enlace.

Este valor no es nuestro. Sale de raspar la pagina de otro, con una expresion
regular, y despues se publica en mil paginas bajo la frase "that is the only
place a claim counts". Es el enlace de mayor confianza del sitio: le estamos
diciendo a alguien que meta sus datos personales ahi para cobrar dinero.

Si la fuente cambia de maqueta, si alguien edita su pagina, o si la regular
muerde un pedazo de texto que no era el dominio, publicamos ese destino con
nuestra recomendacion encima. Eso es phishing con nuestra firma, y no haria
falta que nadie nos atacara: basta un fallo de extraccion.

Asi que nada se publica sin pasar por aqui. Lo que no es un dominio claramente
bien formado se descarta, y la pagina dice que no tenemos sitio registrado,
que es verdad y no le hace dano a nadie.
"""
import re

# Un host normal: etiquetas alfanumericas separadas por puntos y un TLD de
# letras. Sin credenciales, sin puerto, sin espacios, sin dos puntos.
HOST = re.compile(r'^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$', re.I)

# Caminos como FTC.gov/enforcement/refunds/cafepress-settlement. Se permiten,
# pero solo con los caracteres de una ruta corriente.
RUTA = re.compile(r'^[A-Za-z0-9._~\-/%]{0,160}$')

ESQUEMAS_MALOS = ('javascript:', 'data:', 'vbscript:', 'file:', 'about:', 'blob:')


def normalizar(valor):
    """Devuelve una URL https segura, o None si el valor no es de fiar.

    Nunca lanza: entra cualquier cosa que haya quedado en el JSON y sale un
    enlace publicable o nada.
    """
    if not valor or not isinstance(valor, str):
        return None
    # Solo por la cola. Limpiar tambien la cabeza era mas permisivo de lo que
    # parece: convertia <evil.com y "evil.com en un enlace a evil.com con
    # nuestra recomendacion encima, en vez de descartar un valor que
    # evidentemente salio mal de la extraccion. Lo que lleve esos caracteres
    # delante cae en la comprobacion de abajo, que es lo correcto.
    s = re.sub(r'[.,;)"\'<>]+$', '', valor.strip())
    if not s or len(s) > 200:
        return None

    bajo = s.lower()
    if any(c in s for c in ('\n', '\r', '\t', ' ', '\\', '@', '<', '>', '"', "'")):
        return None
    if any(bajo.startswith(e) for e in ESQUEMAS_MALOS) or '%' in bajo[:12]:
        return None

    # El esquema, si viene, solo puede ser http o https. Todo sale en https.
    if bajo.startswith('http://') or bajo.startswith('https://'):
        s = s.split('://', 1)[1]
    elif '://' in s:
        return None

    s = s.lstrip('/')
    host, _, resto = s.partition('/')
    if not HOST.match(host):
        return None
    if resto and not RUTA.match(resto):
        return None
    # Un host con guion al principio o al final de una etiqueta no existe.
    if any(e.startswith('-') or e.endswith('-') for e in host.split('.')):
        return None

    return 'https://' + host + ('/' + resto if resto else '')


def mostrar(valor):
    """Como se escribe el sitio en pantalla: el valor original ya validado."""
    u = normalizar(valor)
    return u.replace('https://', '') if u else None


if __name__ == '__main__':
    pruebas = [
        'NMGSettlement.com', 'www.ExpDataBreachSettlement.com',
        'FTC.gov/enforcement/refunds/cafepress-settlement',
        'https://MintedSettlement.com', 'javascript:alert(1)',
        'evil.com@real.com', 'data:text/html,<script>', '  ',
        'no-es-un-dominio', 'a.b', 'settlement site.com', None,
        'https://x.com/path?a=1', '-mal.com',
    ]
    for p in pruebas:
        print(f'{str(p)[:46]:<48}{normalizar(p)}')
