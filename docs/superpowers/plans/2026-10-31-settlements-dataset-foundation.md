# Settlements dataset foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fresh settlements the weekly scraper already finds reach the money card, and label every card row with the breach's origin.

**Architecture:** The weekly GitHub Actions cron already runs the scraper
(`refresh-open-settlements.py` → `data/open-settlements.json`) and then
`cross-hibp.py`, which writes `settlements.json` (the only file the money card
fetches). The break is that `cross-hibp.py` reads only the frozen historical
catalogues (`data/tca-settlements.json`, `data/cao-lawsuits.json`) and never
reads `open-settlements.json`, so the card is frozen at an October snapshot. We
add `open-settlements.json` as a third input to `cross-hibp.py`, HIBP-match it
with the existing token logic, merge matched open settlements into the card
(preferring the fresh open row when the same breach also has a frozen row), and
add an `origen` field (`ransomware` | `brecha`, default `brecha`) to every card
row. No cron change: the existing workflow already runs `cross-hibp.py` and
commits `settlements.json`.

**Tech Stack:** Python 3.12, standard library only (the tools import no
third-party packages). Tests run locally with `pytest` (a dev-only tool; CI keeps
its own invariant checks and does not run these unit tests).

**Spec:** `docs/superpowers/specs/2026-10-31-settlements-money-wave2-design.md`

## Global Constraints

- US data-breach settlements only; open and closed both kept. (Spec: Constraints.)
- Matching is one-sided-dangerous: a false match tells a stranger they are owed
  money they are not. Keep the existing rules — whole tokens never substrings,
  corporate suffixes dropped, credential dumps excluded, anything doubtful kept
  `dudoso: true` and never shown. (Spec + `cross-hibp.py` module docstring.)
- `settlements.json` is the only file the browser downloads; it carries only what
  the card paints and only non-`dudoso` rows. (`cross-hibp.py` lines 149-151.)
- `porPersona` is a **maximum**, not an owed amount. Do not change its meaning.
- The card dedups to one row per HIBP breach (`visto` set). Keep that.
- Stdlib only in the tools. No new runtime dependency.
- Spanish/English copy is not touched here (this is data only).

## Review Focus

- **An open settlement whose `empresa` matches a HIBP breach by a loose substring
  slips into the card** — must not match (e.g. an open "Canva*" case must not hit
  HIBP "Canva"); covered by Task 3's test using the existing whole-token `core()`.
- **The same breach has both a frozen `tca` row and a fresh open row** — the card
  must show exactly one row, the fresh open one; covered by Task 3's dedup test.
- **An open settlement that is not a data breach** (`filtracion: false`) reaches
  the card — must be dropped; covered by Task 3's test.
- **A card row is written without `origen`** — every row must carry it; covered by
  Task 4's test asserting the key on all rows.
- **The merged card drops below the cron's safety threshold** (`len(tarjeta) < 10`
  fails the workflow) — the merge must only add rows, never remove frozen ones;
  covered by Task 3's count assertion (merged count >= frozen-only count).

---

## File Structure

- `tools/cross-hibp.py` — modified. Extract the nested `indexar`/`cruzar` and the
  card-building into module-level, testable functions; add the open-settlements
  input and the `origen` field.
- `tools/tests/test_cross_hibp.py` — created. Unit tests for the extracted
  functions and the new behavior.
- `tools/tests/__init__.py` — created (empty), so `pytest` discovers the package.
- `data/open-settlements.json` — read only, not modified (the scraper owns it).

### Task 1: pytest harness for the tools

**Files:**
- Create: `tools/tests/__init__.py` (empty)
- Create: `tools/tests/test_cross_hibp.py`

**Interfaces:**
- Produces: a runnable `pytest` suite under `tools/tests/`.

- [ ] **Step 1: Write a trivial failing test** in `tools/tests/test_cross_hibp.py`
  that imports `core` from `cross-hibp` and asserts token normalization:

```python
import importlib.util, os
spec = importlib.util.spec_from_file_location(
    "cross_hibp", os.path.join(os.path.dirname(__file__), "..", "cross-hibp.py"))
cross_hibp = importlib.util.module_from_spec(spec); spec.loader.exec_module(cross_hibp)

def test_core_drops_suffixes_and_lowercases():
    assert cross_hibp.core("Fluke Corporation") == cross_hibp.core("Fluke")
```

(The file name has a hyphen, so it is loaded by path, not `import`.)

- [ ] **Step 2: Run it, expect PASS** (`core` already exists):
  Run: `python3 -m pytest tools/tests/test_cross_hibp.py -v`
  Expected: PASS. If `pytest` is missing: `pip install pytest` first.

- [ ] **Step 3: Commit**

```bash
git add tools/tests/__init__.py tools/tests/test_cross_hibp.py
git commit -m "test: pytest harness for the settlements pipeline"
```

### Task 2: Extract matching and card-building to module level

**Files:**
- Modify: `tools/cross-hibp.py` (move the nested `indexar`, `cruzar`, and the
  card-assembly loop out of `main()` to module scope; `main()` calls them).
- Test: `tools/tests/test_cross_hibp.py`

**Interfaces:**
- Produces:
  - `match_catalogue(hibp: list, filas: list, clave: str, fuente: str) -> list`
    (was the nested `cruzar`; `hibp` is now a parameter). Each element:
    `{'breach','titulo_hibp','cuentas','dominio','fecha_filtracion','fuente','registro'}`.
  - `build_card(cruzado: list, paginas: set) -> list` (was the card loop, lines
    162-186): returns the `tarjeta` list of card rows unchanged in shape.
- Consumes: existing module-level `core`, `slugify`, `claim_site.mostrar`, and the
  module constants `EXCLUIR`, `EQUIVALENTES`, `DUDOSO`, `EN_CURSO`.

- [ ] **Step 1: Write the characterization test** — pin the current card shape so
  the refactor cannot change behavior. Use small in-memory fixtures:

```python
def test_build_card_shape_for_a_paying_settlement():
    cruzado = [{
        "hibp": "Yahoo", "titulo_hibp": "Yahoo", "cuentas": 3000000,
        "dominio": "yahoo.com", "fecha_filtracion": "2016-01-01",
        "empresa": "Yahoo", "fuente_catalogo": "topclassactions",
        "url_caso": "https://example.com/yahoo", "dudoso": False,
        "estado": "acuerdo", "fondo": None, "pago_por_persona": 25000,
        "elegible": "…", "plazo": "2020-07-20",
        "sitio_reclamo": "YahooDataBreachSettlement.com", "caso": None,
    }]
    rows = cross_hibp.build_card(cruzado, paginas=set())
    assert len(rows) == 1
    r = rows[0]
    assert r["hibp"] == "Yahoo" and r["tipo"] == "acuerdo"
    assert r["porPersona"] == 25000 and r["plazo"] == "2020-07-20"
    assert r["sitio"]  # claim_site.mostrar returned a value
```

- [ ] **Step 2: Run it, expect FAIL** (`build_card` not defined yet):
  Run: `python3 -m pytest tools/tests/test_cross_hibp.py -v`
  Expected: FAIL, `AttributeError: build_card`.

- [ ] **Step 3: Refactor** — move `indexar`, `cruzar` (renamed `match_catalogue`,
  with `hibp` as its first parameter), and the card loop (`build_card(cruzado,
  paginas)`) to module scope. `main()` now calls `match_catalogue(hibp, tca,
  'empresa', 'topclassactions')` etc. and `build_card(cruzado, paginas)`. No
  behavior change otherwise.

- [ ] **Step 4: Run the test, expect PASS.** Then run the pipeline end to end and
  confirm the output is byte-identical to before the refactor:
  Run: `cp settlements.json /tmp/before.json && python3 tools/cross-hibp.py && diff /tmp/before.json settlements.json`
  Expected: test PASS; `diff` shows no differences.

- [ ] **Step 5: Commit**

```bash
git add tools/cross-hibp.py tools/tests/test_cross_hibp.py
git commit -m "refactor: extract match_catalogue and build_card for testing"
```

### Task 3: Feed fresh open settlements into the card

**Files:**
- Modify: `tools/cross-hibp.py`
- Test: `tools/tests/test_cross_hibp.py`

**Interfaces:**
- Produces: `open_to_cruzado(open_rows: list, hibp: list) -> list` — HIBP-matches
  the scraper's open settlements (`data/open-settlements.json`) and returns rows
  in the **same shape `build_card` consumes** (the `cruzado` element shape from
  Task 2), with `estado='acuerdo'`, mapping open-settlement fields:
  `empresa`→`empresa`, `pago_por_persona`→`pago_por_persona`, `fondo`→`fondo`,
  `plazo`→`plazo`, `sitio_reclamo`→`sitio_reclamo`, `cubre`→`elegible`. Only rows
  with `filtracion == True` are matched.
- Consumes: `match_catalogue` (Task 2).

- [ ] **Step 1: Write the tests.**

```python
HIBP = [{"Name": "Lands' End", "Title": "Lands' End", "PwnCount": 1,
         "Domain": "landsend.com", "BreachDate": "2024-12-01", "IsSpamList": False,
         "IsMalware": False}]

def test_open_settlement_matches_and_maps():
    openrows = [{"empresa": "Lands' End", "cubre": "…", "plazo": "2026-10-22",
                 "pago_por_persona": 5000, "fondo": None,
                 "sitio_reclamo": "landsenddatasettlement.com", "filtracion": True}]
    cruzado = cross_hibp.open_to_cruzado(openrows, HIBP)
    card = cross_hibp.build_card(cruzado, paginas=set())
    assert len(card) == 1
    assert card[0]["porPersona"] == 5000 and card[0]["plazo"] == "2026-10-22"
    assert card[0]["tipo"] == "acuerdo" and card[0]["sitio"]

def test_non_breach_open_settlement_is_dropped():
    openrows = [{"empresa": "Lands' End", "cubre": "…", "plazo": "2026-10-22",
                 "pago_por_persona": 5000, "sitio_reclamo": "x.com",
                 "filtracion": False}]
    assert cross_hibp.open_to_cruzado(openrows, HIBP) == []

def test_substring_company_does_not_match():
    openrows = [{"empresa": "Canvas Prints Inc", "plazo": "2026-01-01",
                 "pago_por_persona": 10, "sitio_reclamo": "x.com",
                 "filtracion": True}]
    hibp = [{"Name": "Canva", "Title": "Canva", "PwnCount": 1, "Domain": "canva.com",
             "BreachDate": "2019-05-01", "IsSpamList": False, "IsMalware": False}]
    assert cross_hibp.open_to_cruzado(openrows, hibp) == []
```

- [ ] **Step 2: Run, expect FAIL** (`open_to_cruzado` not defined).
  Run: `python3 -m pytest tools/tests/test_cross_hibp.py -k open -v`

- [ ] **Step 3: Implement `open_to_cruzado`** in `tools/cross-hibp.py`: filter to
  `filtracion == True`, call `match_catalogue(hibp, open_rows, 'empresa',
  'classaction.org-open')`, and build each `cruzado` element with
  `estado='acuerdo'` and the field mapping in the Interfaces block.

- [ ] **Step 4: Wire it into `main()` with fresh-wins dedup.** In `main()`, after
  loading, compute `cruzado_open = open_to_cruzado(cargar('open-settlements.json'),
  hibp)` and prepend it to the `tca`/`cao` matches before `build_card`, so the
  `visto` set keeps the fresh open row when a breach appears in both. Keep the
  `casos`/`acuerdos`/`abiertas` summary counts computed from `tca`/`cao` as today.

- [ ] **Step 5: Run the open tests (PASS), then the full suite, then the pipeline.**
  Run: `python3 -m pytest tools/tests/ -v && python3 tools/cross-hibp.py`
  Expected: tests PASS; the run prints a card count >= the pre-change count (open
  rows only add), staying clear of the cron's `len(tarjeta) < 10` floor.

- [ ] **Step 6: Commit**

```bash
git add tools/cross-hibp.py tools/tests/test_cross_hibp.py
git commit -m "feat: feed fresh open settlements into the money card"
```

### Task 4: Label every card row with its origin

**Files:**
- Modify: `tools/cross-hibp.py` (`build_card`, and the `cruzado` builders)
- Test: `tools/tests/test_cross_hibp.py`

**Interfaces:**
- Produces: every card row carries `origen`, one of `"ransomware"` or `"brecha"`,
  default `"brecha"`. A `cruzado` element may carry `origen: "ransomware"` (set by
  its builder when the source flags ransomware); `build_card` copies it to the
  card row, defaulting to `"brecha"` when absent.

- [ ] **Step 1: Write the tests.**

```python
def test_every_card_row_has_origen_default_brecha():
    cruzado = [{  # minimal paying row
        "hibp": "Yahoo", "titulo_hibp": "Yahoo", "cuentas": 1, "dominio": "y.com",
        "fecha_filtracion": "2016-01-01", "empresa": "Yahoo",
        "fuente_catalogo": "topclassactions", "url_caso": "https://x/y",
        "dudoso": False, "estado": "acuerdo", "fondo": None,
        "pago_por_persona": 1, "elegible": "…", "plazo": "2030-01-01",
        "sitio_reclamo": "y.com", "caso": None}]
    assert cross_hibp.build_card(cruzado, set())[0]["origen"] == "brecha"

def test_ransomware_origen_is_carried_through():
    cruzado = [{**_paying_row(), "origen": "ransomware"}]  # helper reuses the row above
    assert cross_hibp.build_card(cruzado, set())[0]["origen"] == "ransomware"
```

- [ ] **Step 2: Run, expect FAIL** (`origen` not on card rows).
  Run: `python3 -m pytest tools/tests/test_cross_hibp.py -k origen -v`

- [ ] **Step 3: Implement.** In `build_card`, set `fila['origen'] =
  r.get('origen', 'brecha')`. Ransomware detection itself (teaching the scraper or
  a cross-ref to flag `origen='ransomware'`) is left to a later task — the radar
  cross-ref is weak because radar domains are masked, so rows stay `brecha` until
  the scraper flags them. This task only guarantees the field exists and is
  carried when present.

- [ ] **Step 4: Run the origen tests (PASS), the full suite, and the pipeline.**
  Run: `python3 -m pytest tools/tests/ -v && python3 tools/cross-hibp.py`
  Expected: all PASS; `settlements.json` rows each have `origen`.

- [ ] **Step 5: Commit**

```bash
git add tools/cross-hibp.py tools/tests/test_cross_hibp.py
git commit -m "feat: label each settlement card row with its origin"
```

---

## Notes for the executor

- Do not touch the Spanish/English copy or `app.js` here; the money card's origin
  label and the "pérdidas" total are Piece 2, a separate plan.
- Do not change the cron workflow: it already runs `cross-hibp.py` and commits
  `settlements.json`. Confirm your change keeps the workflow's post-run checks
  green (`len(casos) >= 800`, `len(tarjeta) >= 10`).
- Increasing the scraper's coverage (it yields ~19 open cases today) is ongoing
  tuning of `refresh-open-settlements.py`, not a task here; this plan makes
  whatever it finds reach the card.
