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
