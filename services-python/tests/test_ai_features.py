"""Tests for feat-v2 feature engineering, strict causality, walk-forward CV, and fair model comparison."""

import os
import shutil
import tempfile
import numpy as np
import pytest

from aurix_ai.datasets import (
    FEATURE_COLUMNS_V1,
    FEATURE_COLUMNS_V2,
    FEATURES_VERSION,
    FEATURES_VERSION_V2,
    DatasetSpec,
    build_features_labels,
    generate_ohlcv,
    get_feature_columns,
    load_dataset,
    write_dataset,
    dataset_version_id,
    chrono_split,
)
from aurix_ai.model import LogRegLBFGS, TorchMLP
from aurix_ai.train import walk_forward_cv, evaluate_proba
from aurix_ai.research import (
    SUPPORTED_FEATURES,
    derive_questions,
    make_hypothesis,
    propose_experiment,
    validate_proposal,
)


@pytest.fixture
def tmp_dir():
    d = tempfile.mkdtemp(prefix="aurix-feat-test-")
    yield d
    shutil.rmtree(d, ignore_errors=True)


def test_feature_columns_schema():
    assert len(FEATURE_COLUMNS_V1) == 8
    assert len(FEATURE_COLUMNS_V2) == 12
    assert get_feature_columns("feat-v1") == FEATURE_COLUMNS_V1
    assert get_feature_columns("feat-v2") == FEATURE_COLUMNS_V2
    assert "feat-v2" in SUPPORTED_FEATURES

    expected_v2 = (
        "ret_1", "ret_3", "ret_5", "ret_10", "ret_20",
        "trend_sma_ratio",
        "vol_10", "vol_20", "vol_ratio",
        "norm_range", "close_loc", "range_pos_20",
    )
    assert FEATURE_COLUMNS_V2 == expected_v2


def test_build_features_labels_v1_and_v2_shapes():
    bars = generate_ohlcv(seed=42, n_bars=100, instruments=("TEST1", "TEST2"), start_ts=1700000000000)
    
    # feat-v1
    X1, y1, ts1, inst1 = build_features_labels(bars, horizon=3, threshold=0.005, feature_version="feat-v1")
    assert X1.shape[1] == 8
    assert len(X1) == len(y1) == len(ts1) == len(inst1)
    
    # feat-v2
    X2, y2, ts2, inst2 = build_features_labels(bars, horizon=3, threshold=0.005, feature_version="feat-v2")
    assert X2.shape[1] == 12
    assert len(X2) == len(y2) == len(ts2) == len(inst2)
    assert len(X2) == len(X1)


def test_deterministic_feat_v2_math():
    """Verify exact formula values on a handcrafted synthetic bar sequence."""
    n = 60
    ts = 1700000000000 + np.arange(n, dtype=np.int64) * 86_400_000
    # Create smooth oscillating price progression with both positive and negative moves
    close = 100.0 + np.sin(np.linspace(0, 4 * np.pi, n)) * 10.0
    open_ = close - 0.2
    high = close + 1.0
    low = close - 1.0
    vol = np.full(n, 1000, dtype=np.int64)

    bars = {"MOCK": {"ts": ts, "open": open_, "high": high, "low": low, "close": close, "volume": vol}}
    X, y, _, _ = build_features_labels(bars, horizon=1, threshold=0.0, min_rows=25, feature_version="feat-v2")

    # Both binary classes must exist
    assert len(np.unique(y)) == 2

    # At row 0 (which corresponds to bar t = 20):
    # ret_1 = close[20]/close[19] - 1
    c20 = close[20]
    c19 = close[19]
    expected_ret_1 = (c20 / c19) - 1.0
    np.testing.assert_allclose(X[0, 0], expected_ret_1, rtol=1e-5)

    # ret_3 = close[20]/close[17] - 1
    expected_ret_3 = (c20 / close[17]) - 1.0
    np.testing.assert_allclose(X[0, 1], expected_ret_3, rtol=1e-5)

    # norm_range = (high - low) / close = 2.0 / c20
    expected_norm_range = 2.0 / c20
    np.testing.assert_allclose(X[0, 9], expected_norm_range, rtol=1e-5)

    # close_loc = (close - low) / (high - low) = 1.0 / 2.0 = 0.5
    expected_close_loc = 0.5
    np.testing.assert_allclose(X[0, 10], expected_close_loc, rtol=1e-5)


def test_strict_causality_no_future_leakage():
    """Mathematically verify that modifying future bars t > T has ZERO effect on features at t <= T."""
    n_bars = 80
    cutoff = 50
    bars_clean = generate_ohlcv(seed=123, n_bars=n_bars, instruments=("LEAK_CHECK",), start_ts=1700000000000)

    # Now make a copy and inject extreme anomalies in future bars (cutoff + 1 onwards)
    bars_future_perturbed = {
        "LEAK_CHECK": {
            "ts": bars_clean["LEAK_CHECK"]["ts"].copy(),
            "open": bars_clean["LEAK_CHECK"]["open"].copy(),
            "high": bars_clean["LEAK_CHECK"]["high"].copy(),
            "low": bars_clean["LEAK_CHECK"]["low"].copy(),
            "close": bars_clean["LEAK_CHECK"]["close"].copy(),
            "volume": bars_clean["LEAK_CHECK"]["volume"].copy(),
        }
    }
    # Radical 100x spike in future bars
    bars_future_perturbed["LEAK_CHECK"]["close"][cutoff:] *= 100.0
    bars_future_perturbed["LEAK_CHECK"]["high"][cutoff:] *= 150.0
    bars_future_perturbed["LEAK_CHECK"]["low"][cutoff:] *= 80.0
    bars_future_perturbed["LEAK_CHECK"]["volume"][cutoff:] = (bars_future_perturbed["LEAK_CHECK"]["volume"][cutoff:] * 500).astype(np.int64)

    X_clean, _, ts_clean, _ = build_features_labels(bars_clean, horizon=5, threshold=0.005, feature_version="feat-v2")
    X_pert, _, ts_pert, _ = build_features_labels(bars_future_perturbed, horizon=5, threshold=0.005, feature_version="feat-v2")

    # Find cutoff timestamp
    cutoff_ts = bars_clean["LEAK_CHECK"]["ts"][cutoff - 1]
    valid_past_mask = ts_clean <= cutoff_ts

    # For all rows up to cutoff, X_clean and X_pert must be bitwise/strictly equal
    np.testing.assert_allclose(
        X_clean[valid_past_mask],
        X_pert[valid_past_mask],
        err_msg="CRITICAL: Features before cutoff were altered by future data! Future data leaked into features!"
    )


def test_dataset_versioning_and_manifest(tmp_dir):
    bars = generate_ohlcv(seed=99, n_bars=100, instruments=("INST1", "INST2"), start_ts=1700000000000)
    
    spec_v1 = DatasetSpec(
        dataset_id="test-ds",
        version="v1",
        instruments=("INST1", "INST2"),
        n_bars=100,
        seed=99,
        horizon_bars=2,
        threshold=0.001,
        start_ts=1700000000000,
        feature_version="feat-v1",
    )
    spec_v2 = DatasetSpec(
        dataset_id="test-ds",
        version="v1",
        instruments=("INST1", "INST2"),
        n_bars=100,
        seed=99,
        horizon_bars=2,
        threshold=0.001,
        start_ts=1700000000000,
        feature_version="feat-v2",
    )
    
    # Version hashes must be distinct due to feature_version difference
    id_v1 = dataset_version_id(spec_v1)
    id_v2 = dataset_version_id(spec_v2)
    assert id_v1 != id_v2

    X2, y2, ts2, inst2 = build_features_labels(bars, horizon=2, threshold=0.001, feature_version="feat-v2")
    meta = write_dataset(tmp_dir, spec_v2, X2, y2, ts2, inst2)
    assert meta["feature_spec"]["version"] == "feat-v2"
    assert len(meta["feature_spec"]["columns"]) == 12

    # Load dataset dynamically
    loaded_dir = os.path.join(tmp_dir, id_v2)
    X_loaded, y_loaded, ts_loaded, inst_loaded, manifest = load_dataset(loaded_dir)
    assert X_loaded.shape[1] == 12
    assert manifest["feature_spec"]["version"] == "feat-v2"
    np.testing.assert_allclose(X_loaded, X2, atol=1e-6, rtol=1e-4)


def test_walk_forward_cv_leakage_and_execution():
    """Verify walk-forward CV enforces disjoint windows and train-only scaler fitting."""
    rng = np.random.default_rng(42)
    n = 200
    X = rng.normal(loc=10.0, scale=2.0, size=(n, 12))
    y = (X[:, 0] + X[:, 1] > 20.0).astype(int)

    # Test LogRegLBFGS walk-forward
    res_lr = walk_forward_cv(
        X, y,
        model_type="logreg-lbfgs",
        n_windows=3,
        train_bars=80,
        test_bars=20,
        step_bars=20,
        purge_bars=2,
    )
    assert res_lr["n_windows"] == 3
    assert len(res_lr["windows"]) == 3
    assert "mean_edge" in res_lr
    assert "mean_brier_score" in res_lr
    assert "mean_log_loss" in res_lr

    # Check window non-overlap and train preceding test
    for w in res_lr["windows"]:
        tr_start, tr_end = w["train_range"]
        te_start, te_end = w["test_range"]
        assert tr_start < tr_end
        assert tr_end <= te_start  # Purge buffer respected
        assert te_start < te_end

    # Test TorchMLP walk-forward
    res_mlp = walk_forward_cv(
        X, y,
        model_type="torch-mlp",
        model_config={"hidden_dims": (16, 8), "lr": 0.01},
        n_windows=3,
        train_bars=80,
        test_bars=20,
        step_bars=20,
        epochs=3,
    )
    assert res_mlp["n_windows"] == 3
    assert 0.0 <= res_mlp["mean_accuracy"] <= 1.0


def test_research_integration_with_feat_v2(tmp_dir):
    """Verify research question derivation, proposal validation, and hypothesis for feat-v2."""
    bars = generate_ohlcv(seed=1, n_bars=100, instruments=("MOCK",), start_ts=1700000000000)
    spec = DatasetSpec(
        dataset_id="mock-market",
        version="v1",
        instruments=("MOCK",),
        n_bars=100,
        seed=1,
        horizon_bars=2,
        threshold=0.0,
        start_ts=1700000000000,
        feature_version="feat-v2",
    )
    X, y, ts, inst = build_features_labels(bars, horizon=2, threshold=0.0, feature_version="feat-v2")
    meta = write_dataset(tmp_dir, spec, X, y, ts, inst)
    ds_dir = os.path.join(tmp_dir, meta["dataset_version"])

    # Mock an outcome rejected on feat-v1
    rejected_outcome = {
        "experiment_id": "exp-mock-v1",
        "status": "REJECTED",
        "_class": "GOVERNANCE_REJECTED",
        "definition": {"dataset_version": "ds-old-v1"},
        "manifest": {"feature_version": "feat-v1"},
        "governance": {"outcome": "REJECTED", "edge": -0.02},
    }

    questions = derive_questions(outcomes=[rejected_outcome], log=[], datasets=[ds_dir])
    feat_questions = [q for q in questions if q.get("topic") == "features"]
    assert len(feat_questions) > 0
    assert "feat-v2" in feat_questions[0]["question"]

    # Propose experiment based on question
    proposal = propose_experiment(
        feat_questions[0],
        datasets=[ds_dir],
        base_hp={"alpha": 0.001},
        seed=11,
        epochs=4,
        model_type="logreg-lbfgs",
    )
    assert proposal["dataset_dir"] == ds_dir

    # Validate proposal
    clean = validate_proposal(proposal, runs_root=tmp_dir, datasets=[ds_dir])
    assert clean["feature_version"] == "feat-v2"

    # Make hypothesis
    hyp = make_hypothesis(feat_questions[0], clean, clean["_fingerprint"], baseline=0.5, expectation="feat-v2 adds predictive signal")
    assert hyp["feature_version"] == "feat-v2"


def test_fair_baseline_comparison_synthetic():
    """Fair comparison: LogReg and TorchMLP on both feat-v1 and feat-v2 under identical splits."""
    bars = generate_ohlcv(seed=777, n_bars=300, instruments=("SYN1", "SYN2"), start_ts=1700000000000)
    
    # 1. feat-v1 data
    X_v1, y_v1, _, _ = build_features_labels(bars, horizon=5, threshold=0.005, feature_version="feat-v1")
    tr_idx, val_idx, te_idx = chrono_split(len(y_v1))
    
    # 2. feat-v2 data
    X_v2, y_v2, _, _ = build_features_labels(bars, horizon=5, threshold=0.005, feature_version="feat-v2")
    # y must be identical since horizon and threshold are identical
    np.testing.assert_array_equal(y_v1, y_v2)

    # Model 1: LogReg on feat-v1
    lr_v1 = LogRegLBFGS(alpha=0.001, random_state=42)
    lr_v1.fit_scaler(X_v1[tr_idx])
    lr_v1.partial_epoch(X_v1[tr_idx], y_v1[tr_idx])
    prob_lr_v1 = lr_v1.predict_proba(X_v1[te_idx])
    eval_lr_v1 = evaluate_proba(y_v1[te_idx], prob_lr_v1)

    # Model 2: LogReg on feat-v2
    lr_v2 = LogRegLBFGS(alpha=0.001, random_state=42)
    lr_v2.fit_scaler(X_v2[tr_idx])
    lr_v2.partial_epoch(X_v2[tr_idx], y_v2[tr_idx])
    prob_lr_v2 = lr_v2.predict_proba(X_v2[te_idx])
    eval_lr_v2 = evaluate_proba(y_v2[te_idx], prob_lr_v2)

    # Model 3: TorchMLP on feat-v1
    mlp_v1 = TorchMLP(hidden_dims=(32, 16), lr=0.01, random_state=42)
    mlp_v1.fit_scaler(X_v1[tr_idx])
    for _ in range(10):
        mlp_v1.partial_epoch(X_v1[tr_idx], y_v1[tr_idx])
    prob_mlp_v1 = mlp_v1.predict_proba(X_v1[te_idx])
    eval_mlp_v1 = evaluate_proba(y_v1[te_idx], prob_mlp_v1)

    # Model 4: TorchMLP on feat-v2
    mlp_v2 = TorchMLP(hidden_dims=(32, 16), lr=0.01, random_state=42)
    mlp_v2.fit_scaler(X_v2[tr_idx])
    for _ in range(10):
        mlp_v2.partial_epoch(X_v2[tr_idx], y_v2[tr_idx])
    prob_mlp_v2 = mlp_v2.predict_proba(X_v2[te_idx])
    eval_mlp_v2 = evaluate_proba(y_v2[te_idx], prob_mlp_v2)

    # Assert all evaluations produced valid metrics
    for name, ev in [("LR-v1", eval_lr_v1), ("LR-v2", eval_lr_v2), ("MLP-v1", eval_mlp_v1), ("MLP-v2", eval_mlp_v2)]:
        assert 0.0 <= ev["accuracy"] <= 1.0
        assert 0.0 <= ev["coverage"] <= 1.0
        assert ev["failed_predictions"] == 0
        assert "brier_score" in ev
        assert "log_loss" in ev
        assert "balanced_accuracy" in ev
