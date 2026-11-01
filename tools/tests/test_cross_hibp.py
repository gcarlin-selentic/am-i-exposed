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


_HIBP_LANDS = [{"Name": "Lands' End", "Title": "Lands' End", "PwnCount": 1,
                "Domain": "landsend.com", "BreachDate": "2024-12-01",
                "IsSpamList": False, "IsMalware": False}]


def test_open_settlement_matches_and_maps():
    openrows = [{"empresa": "Lands' End", "cubre": "covered", "plazo": "2026-10-22",
                 "pago_por_persona": 5000, "fondo": None,
                 "sitio_reclamo": "landsenddatasettlement.com", "filtracion": True}]
    cruzado = cross_hibp.open_to_cruzado(openrows, _HIBP_LANDS)
    card = cross_hibp.build_card(cruzado, paginas=set())
    assert len(card) == 1
    assert card[0]["porPersona"] == 5000 and card[0]["plazo"] == "2026-10-22"
    assert card[0]["tipo"] == "acuerdo" and card[0]["sitio"]


def test_non_breach_open_settlement_is_dropped():
    openrows = [{"empresa": "Lands' End", "cubre": "covered", "plazo": "2026-10-22",
                 "pago_por_persona": 5000, "sitio_reclamo": "x.com",
                 "filtracion": False}]
    assert cross_hibp.open_to_cruzado(openrows, _HIBP_LANDS) == []


def test_substring_company_does_not_match():
    openrows = [{"empresa": "Canvas Prints Inc", "plazo": "2026-01-01",
                 "pago_por_persona": 10, "sitio_reclamo": "x.com",
                 "filtracion": True}]
    hibp = [{"Name": "Canva", "Title": "Canva", "PwnCount": 1, "Domain": "canva.com",
             "BreachDate": "2019-05-01", "IsSpamList": False, "IsMalware": False}]
    assert cross_hibp.open_to_cruzado(openrows, hibp) == []
