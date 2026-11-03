"""firecrawl() debe devolver siempre una tripleta (datos, enlaces, url_final).

El 2026-11-02 la rutina semanal "Refresh open settlements" se cayo con
`ValueError: too many values to unpack (expected 3)`: la rama de error de pago
(HTTP 402/401/403) devolvia cuatro valores, pero las dos llamadas a firecrawl()
desempaquetan tres. El fallo estuvo latente hasta que Firecrawl empezo a
responder 402 sobre classaction.org. Este test fija la aridad de esa rama.
"""
import importlib.util
import pathlib
import urllib.error
from unittest import mock

MOD = pathlib.Path(__file__).resolve().parents[1] / 'refresh-open-settlements.py'


def cargar():
    spec = importlib.util.spec_from_file_location('refresh_open_settlements', MOD)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_firecrawl_pago_requerido_devuelve_tripleta():
    m = cargar()
    err = urllib.error.HTTPError(m.API, 402, 'Payment Required', {}, None)
    with mock.patch.object(m.urllib.request, 'urlopen', side_effect=err):
        resultado = m.firecrawl('https://www.classaction.org/settlements')
    assert len(resultado) == 3, f'se esperaban 3 valores, llegaron {len(resultado)}'
    d, enlaces, final = resultado  # no debe lanzar ValueError
    assert d == {}
    assert enlaces == []
    assert final == 'https://www.classaction.org/settlements'


def test_firecrawl_no_autorizado_devuelve_tripleta():
    m = cargar()
    err = urllib.error.HTTPError(m.API, 401, 'Unauthorized', {}, None)
    with mock.patch.object(m.urllib.request, 'urlopen', side_effect=err):
        resultado = m.firecrawl('https://example.com/x')
    assert len(resultado) == 3
    d, enlaces, final = resultado
    assert (d, enlaces, final) == ({}, [], 'https://example.com/x')
