"""Laya integration tests — installed-API surface only (no weight downloads).

The real Agent inference runs in the proof report (`laya-decide`), not in unit
tests, to keep the suite offline-safe and fast. Calibration uses real synthetic
probabilities through the actual installed `fit_temperature_map`.
"""

import pytest

laya = pytest.importorskip("laya", reason="laya not installed")


def test_laya_version_and_api_surface():
    from aurix_ai.laya_component import REQUIRED_API, probe_laya
    probe = probe_laya()
    assert probe["laya_version"] not in (None, "")
    assert all(probe["capabilities"][k] for k in REQUIRED_API), probe["capabilities"]
    assert probe["python"].startswith("3.")


def test_laya_calibration_fit_real():
    import numpy as np
    from aurix_ai.laya_component import calibration_fit
    rng = np.random.default_rng(7)
    probas = list(rng.uniform(0.05, 0.95, size=60))
    labels = [1 if p + rng.normal(0, 0.2) > 0.5 else 0 for p in probas]
    out = calibration_fit(probas, labels, seed=7)
    assert isinstance(out, dict) and len(out) > 0


def test_laya_decide_schema_surface():
    import inspect
    assert "schema" in inspect.signature(laya.decide).parameters
    assert "questions" in inspect.signature(laya.decide).parameters
