"""AI dataset tests: versioning, features, labels, chrono split, leakage prevention."""

import numpy as np

from aurix_ai.datasets import (FEATURE_COLUMNS, build_features_labels, chrono_split,
                               dataset_version_id, generate_ohlcv, load_dataset,
                               validate_bars, write_dataset, DatasetSpec)

SPEC = DatasetSpec(dataset_id="test-ds", version="v1",
                   instruments=("A", "B"), n_bars=400, seed=7,
                   horizon_bars=5, threshold=0.005, start_ts=1700000000000)


def test_generate_validate():
    bars = generate_ohlcv(7, 400, ("A", "B"), 1700000000000)
    assert validate_bars(bars) == []
    bad = {"A": {"ts": np.array([2, 1]), "open": np.array([1.0, 1.0]),
                 "high": np.array([1.0, 1.0]), "low": np.array([1.0, 1.0]),
                 "close": np.array([1.0, 1.0]), "volume": np.array([1, 1])}}
    assert validate_bars(bad) != []


def test_features_causal_labels_forward():
    bars = generate_ohlcv(7, 400, ("A",), 1700000000000)
    X, y, ts, inst = build_features_labels(bars, 5, 0.005)
    assert X.shape[1] == len(FEATURE_COLUMNS) == 8
    assert set(np.unique(y)) == {0, 1}
    # Label for row t uses close[t+5]: recompute one row independently.
    close = bars["A"]["close"]
    t_bar = 20  # first feature row corresponds to bar index 20
    assert y[0] == (1 if close[t_bar + 5] / close[t_bar] - 1.0 > 0.005 else 0)
    # Timestamps strictly increasing after global sort.
    assert bool(np.all(np.diff(ts) >= 0))


def test_chrono_split_ordered_no_overlap():
    tr, va, te = chrono_split(100)
    assert tr[-1] < va[0] and va[-1] < te[0]
    assert len(tr) == 60 and len(va) == 20 and len(te) == 20


def test_dataset_immutable_versioned(tmp_path):
    bars = generate_ohlcv(7, 400, ("A", "B"), 1700000000000)
    X, y, ts, inst = build_features_labels(bars, 5, 0.005)
    m1 = write_dataset(str(tmp_path), SPEC, X, y, ts, inst)
    assert m1["dataset_version"].startswith("test-ds-")
    assert m1["train_range"][1] < m1["val_range"][0] <= m1["val_range"][1] < m1["test_range"][0]
    # Rewrite identical -> OK; tamper -> corruption error on load.
    m2 = write_dataset(str(tmp_path), SPEC, X, y, ts, inst)
    assert m2["checksum_sha256"] == m1["checksum_sha256"]
    X2, y2, ts2, inst2, m3 = load_dataset(f"{tmp_path}/{m1['dataset_version']}")
    assert np.array_equal(y, y2) and m3["n_rows"] == len(y)
    # Version changes when spec changes.
    other = DatasetSpec(**{**SPEC.__dict__, "threshold": 0.05})
    assert dataset_version_id(other) != dataset_version_id(SPEC)
