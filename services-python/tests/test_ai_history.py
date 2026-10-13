"""History-layer tests: provider parsing (fixtures, no network), validation
verdicts, versioning/checksum, builder reuse, backtest-bar shape, leakage."""

import json

import numpy as np
import pytest

from aurix_ai.datasets import build_features_labels, chrono_split
from aurix_ai.history import (Eod2Provider, TejBazaarProvider, cross_check,
                              to_backtest_bars, to_training_bars, validate_rows)

TEJ_ROWS = [
    {"symbol": "RELIANCE", "date": "2024-01-01", "open": 100.0, "high": 102.0,
     "low": 99.0, "close": 101.0, "volume": 1000, "turnover": 1.0, "trades": 10,
     "adjusted": False, "source": "tej-bazaar"},
    {"symbol": "RELIANCE", "date": "2024-01-02", "open": 101.0, "high": 103.0,
     "low": 100.0, "close": 102.0, "volume": 1100, "turnover": 1.0, "trades": 11,
     "adjusted": False, "source": "tej-bazaar"},
]


def _series(n=120, seed=3):
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0004, 0.012, size=n)
    close = 100.0 * np.cumprod(1.0 + rets)
    rows = []
    for t in range(n):
        o = close[t - 1] if t else 100.0
        c = close[t]
        rows.append({"symbol": "T", "date": f"2020-{(t // 28) + 1:02d}-{(t % 28) + 1:02d}",
                     "open": o, "high": max(o, c) * 1.001, "low": min(o, c) * 0.999,
                     "close": c, "volume": 100000, "turnover": 1.0, "trades": 5,
                     "adjusted": False, "source": "tej-bazaar"})
    # unique sortable dates: rebuild as sequential days from 2020-01-01
    import datetime
    base = datetime.date(2020, 1, 1)
    for i, r in enumerate(rows):
        r["date"] = str(base + datetime.timedelta(days=i))
    return rows


def test_providers_expose_minimal_interface():
    for p in (TejBazaarProvider(), Eod2Provider()):
        assert callable(p.fetch)
        meta = p.source_meta()
        assert meta["provider"] and meta["adjustment_policy"]


def test_validation_verdicts():
    ok = validate_rows(_series())
    assert ok["verdict"] in ("PASS", "QUARANTINE")
    assert ok["n_raw"] == 120 and len(ok["clean"]) > 100
    bad = [dict(r) for r in _series(30)]
    bad[5]["high"] = bad[5]["low"] - 1  # impossible OHLC
    bad[6]["close"] = -3  # negative price
    bad[7]["volume"] = -9  # negative volume
    bad.append(dict(bad[8]))  # duplicate timestamp
    bad.append({"symbol": "T", "date": "not-a-date", "open": 1, "high": 1,
                "low": 1, "close": 1, "volume": 1})
    rep = validate_rows(bad)
    assert rep["verdict"] == "QUARANTINE"
    reasons = {r for q in rep["quarantined"] for r in q["reasons"]}
    assert {"impossible-ohlc", "invalid-close", "invalid-volume",
            "duplicate-timestamp", "malformed-date"} <= reasons
    # Nothing silently deleted: raw = clean + quarantined(non-gap).
    flagged = [q for q in rep["quarantined"] if q["index"] != -1]
    assert len(rep["clean"]) + len(flagged) == rep["n_raw"]


def test_builder_reuse_and_chrono_leakage():
    rows = {}
    for sym, seed in (("A", 3), ("B", 5)):
        rep = validate_rows(_series(200, seed=seed))
        assert rep["clean"], sym
        rows[sym] = rep["clean"]
    bars = to_training_bars(rows)
    X, y, ts, inst = build_features_labels(bars, 5, 0.005)
    assert X.shape[1] == 8 and set(np.unique(y)) == {0, 1}
    tr, va, te = chrono_split(len(y))
    assert ts[tr[-1]] < ts[va[0]] and ts[va[-1]] < ts[te[0]]


def test_backtest_bar_shape():
    rep = validate_rows(_series(25))
    bars = to_backtest_bars({"RELIANCE": rep["clean"]})
    assert len(bars) == len(rep["clean"]) == 25
    for b in bars:
        assert set(b) == {"instrument_id", "ts", "open", "high", "low",
                          "close", "volume", "spread_bps", "adv_value"}
        assert b["instrument_id"] == "NSE_EQ_RELIANCE"
        assert isinstance(b["ts"], int) and b["ts"] > 0


def test_cross_check_identical():
    rows = _series(30)
    rep = cross_check(rows, [dict(r) for r in rows])
    assert rep["n_common"] == 30 and rep["max_abs_pct_diff"] == 0.0


def test_history_no_broker_surface():
    import aurix_ai.history as h
    import os
    src = open(os.path.dirname(h.__file__) + "/history.py").read()
    for pat in ("placeOrder", "BrokerPort", "kiteconnect", "api_secret",
                "access_token", "execution-service"):
        assert pat not in src


def test_history_build_defaults_to_adjusted_source():
    """U4: the training-dataset selection path defaults to eod2-adjusted."""
    from aurix_ai.cli import build_parser
    from aurix_ai.history import Eod2Provider
    args = build_parser().parse_args(
        ["history-build", "--symbols", "RELIANCE", "--from-date", "2020-01-01",
         "--to-date", "2020-02-01", "--out", "o"])
    assert args.provider == "eod2"
    assert Eod2Provider.adjustment_policy == "split-bonus-adjusted"


def test_write_dataset_records_basis_and_keeps_stable_ids(tmp_path):
    """U4: manifests record the price basis; IDs/checksums stay stable."""
    from aurix_ai.datasets import (DatasetSpec, build_features_labels,
                                   write_dataset)
    rows = {}
    for sym, seed in (("A", 3), ("B", 5)):
        rep = validate_rows(_series(200, seed=seed))
        rows[sym] = rep["clean"]
    bars = to_training_bars(rows)
    X, y, ts, inst = build_features_labels(bars, 5, 0.005)
    spec = DatasetSpec(dataset_id="aurix-nse-daily", version="v1",
                       instruments=("A", "B"), n_bars=400, seed=7,
                       horizon_bars=5, threshold=0.005, start_ts=int(ts[0]))
    extra = {"source": "eod2-data",
             "source_ref": "BennyThadikaran/eod2_data@main",
             "adjustment_policy": "split-bonus-adjusted"}
    m1 = write_dataset(str(tmp_path), spec, X, y, ts, inst, extra=extra)
    m2 = write_dataset(str(tmp_path), spec, X, y, ts, inst, extra=extra)
    assert m1["adjustment_policy"] == "split-bonus-adjusted"
    assert m1["source"] == "eod2-data"
    assert m1["dataset_version"] == m2["dataset_version"]
    assert m1["checksum_sha256"] == m2["checksum_sha256"]
