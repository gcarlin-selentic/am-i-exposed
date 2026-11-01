"""Tests for tools/cross-hibp.py. The module's filename has a hyphen, so it is
loaded by path rather than imported."""
import importlib.util
import os

_HERE = os.path.dirname(__file__)
_spec = importlib.util.spec_from_file_location(
    "cross_hibp", os.path.join(_HERE, "..", "cross-hibp.py"))
cross_hibp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cross_hibp)


def test_core_drops_suffixes_and_lowercases():
    assert cross_hibp.core("Fluke Corporation") == cross_hibp.core("Fluke")


def test_build_card_shape_for_a_paying_settlement():
    cruzado = [{
        "hibp": "Yahoo", "titulo_hibp": "Yahoo", "cuentas": 3000000,
        "dominio": "yahoo.com", "fecha_filtracion": "2016-01-01",
        "empresa": "Yahoo", "fuente_catalogo": "topclassactions",
        "url_caso": "https://example.com/yahoo", "dudoso": False,
        "estado": "acuerdo", "fondo": None, "pago_por_persona": 25000,
        "elegible": "...", "plazo": "2020-07-20",
        "sitio_reclamo": "YahooDataBreachSettlement.com", "caso": None,
    }]
    rows = cross_hibp.build_card(cruzado, paginas=set())
    assert len(rows) == 1
    r = rows[0]
    assert r["hibp"] == "Yahoo" and r["tipo"] == "acuerdo"
    assert r["porPersona"] == 25000 and r["plazo"] == "2020-07-20"
    assert r["sitio"]
