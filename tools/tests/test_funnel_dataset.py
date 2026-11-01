"""Tests for the funnel dataset builder (tools/_funnel.py). The money/number
funnel reads a single reconciled dataset; these pin the counts, the open set
and the Paso-2 chip list so they cannot drift from the publishable universe."""
import datetime
import importlib.util
import os

_HERE = os.path.dirname(__file__)
_spec = importlib.util.spec_from_file_location(
    "_funnel", os.path.join(_HERE, "..", "_funnel.py"))
_funnel = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_funnel)


def caso(empresa, tipo, pago=None, fondo=None, plazo=None,
         abierto=False, en_hibp=False, sitio=None):
    """An index row shaped like build-settlement-pages.py's `indice` entries."""
    slug = empresa.lower().replace(' ', '-')
    return {'ruta': f'/settlements/{slug}/', 'empresa': empresa, 'tipo': tipo,
            'fondo': fondo, 'pago': pago, 'plazo': plazo, 'abierto': abierto,
            'sitio': sitio, 'en_hibp': en_hibp}


FIXTURE = [
    caso('University Of Phoenix', 'abierto', pago=25, plazo='2026-11-05',
         abierto=True, sitio='uop.com'),
    caso('Johnson Johnson', 'abierto', fondo=4700000, plazo='2026-11-25',
         abierto=True, sitio='jj.com'),              # fund, no per-person
    caso('Kimco Staffing', 'abierto', pago=5000, plazo='2026-12-15',
         abierto=True, sitio='kimco.com'),
    caso('Yahoo', 'acuerdo', pago=25000, plazo='2020-07-20', en_hibp=True,
         sitio='yahoo.com'),
    caso('Equifax', 'acuerdo', pago=20000, plazo='2022-01-22', en_hibp=True),
    caso('Some Suit', 'investigacion abierta'),
]
HOY = datetime.date(2026, 11, 1)


def test_meta_counts_match_the_publishable_universe():
    d = _funnel.build_funnel(FIXTURE, HOY)
    assert d['meta']['casos'] == 6
    assert d['meta']['acuerdos'] == 2
    assert d['meta']['abiertos'] == 3


def test_open_rows_are_future_and_have_an_amount_sorted_by_deadline():
    d = _funnel.build_funnel(FIXTURE, HOY)
    assert [o['empresa'] for o in d['open']] == [
        'University Of Phoenix', 'Johnson Johnson', 'Kimco Staffing']
    for o in d['open']:
        assert o['plazo'] >= HOY.isoformat()
        assert (o['porPersona'] is not None) or (o['fondo'] is not None)
    jj = next(o for o in d['open'] if o['empresa'] == 'Johnson Johnson')
    assert jj['porPersona'] is None and jj['fondo'] == 4700000


def test_max_per_person_excludes_funds():
    d = _funnel.build_funnel(FIXTURE, HOY)
    # 5000 (Kimco) and 25 (UoP); J&J's 4.7M fund is not a per-person amount.
    assert d['meta']['maxPorPersona'] == 5000


def test_open_slug_derived_from_route():
    d = _funnel.build_funnel(FIXTURE, HOY)
    assert d['open'][0]['slug'] == 'university-of-phoenix'


def test_chips_are_unique_and_include_every_open_company():
    d = _funnel.build_funnel(FIXTURE, HOY)
    slugs = [c['slug'] for c in d['chips']]
    assert len(slugs) == len(set(slugs))
    open_slugs = {o['slug'] for o in d['open']}
    assert open_slugs <= set(slugs)
    # the highest-paying HIBP-matched companies are offered as chips too
    assert 'yahoo' in slugs and 'equifax' in slugs
