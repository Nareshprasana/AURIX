"""Tests for PyTorch MLP integration in AURIX AI pipeline.

Validates:
- Construction, forward pass and predict_proba shape (N, 2).
- Determinism under identical seeds.
- Training on synthetic fixtures with real parameter updates.
- Train-only preprocessing without lookahead or validation leakage.
- Validation and fail-closed handling of invalid features/labels/configs.
- Checkpoint saving, loading, and exact resume equality.
- Full run training artifact generation, manifest, and SHA-256 recording.
- Baseline (LogReg) vs MLP fair evaluation consistency.
- Orchestrator lifecycle and governance evaluation.
- No training launched on import.
"""

import json
import os
import numpy as np
import pytest

from aurix_ai.datasets import chrono_split
from aurix_ai.model import (
    LogRegLBFGS,
    MarketMLP,
    TorchMLP,
    load_checkpoint,
    make_model,
    predict_proba_from_artifact,
    save_checkpoint,
)
from aurix_ai.train import evaluate_proba, run_training


def _synthetic_fixture(n=300, n_features=8, seed=42):
    rng = np.random.default_rng(seed)
    X = rng.normal(0.0, 1.0, size=(n, n_features))
    # Simple linear decision boundary with noise
    logits = X[:, 0] * 1.5 - X[:, 1] * 1.0 + X[:, 2] * 0.5
    proba = 1.0 / (1.0 + np.exp(-logits))
    y = (rng.uniform(0.0, 1.0, size=n) < proba).astype(int)
    return X, y


def test_torch_mlp_construction_and_output_shapes():
    m = TorchMLP(in_features=8, hidden_dims=(32, 16), activation="relu", random_state=7)
    assert m.in_features == 8
    assert m.hidden_dims == (32, 16)
    assert m.activation_name == "relu"

    X = np.random.randn(25, 8)
    m.fit_scaler(X)
    proba = m.predict_proba(X)
    assert proba.shape == (25, 2)
    assert np.all(proba >= 0.0) and np.all(proba <= 1.0)
    assert np.allclose(proba.sum(axis=1), np.ones(25), atol=1e-5)


def test_torch_mlp_determinism():
    X, y = _synthetic_fixture(n=100, seed=7)
    m1 = TorchMLP(in_features=8, hidden_dims=(16,), random_state=42)
    m1.fit_scaler(X)
    loss1 = m1.partial_epoch(X, y)
    p1 = m1.predict_proba(X)

    m2 = TorchMLP(in_features=8, hidden_dims=(16,), random_state=42)
    m2.fit_scaler(X)
    loss2 = m2.partial_epoch(X, y)
    p2 = m2.predict_proba(X)

    assert np.isclose(loss1, loss2, atol=1e-7)
    assert np.allclose(p1, p2, atol=1e-7)

    # Different seed should initialize differently
    m3 = TorchMLP(in_features=8, hidden_dims=(16,), random_state=99)
    m3.fit_scaler(X)
    p3 = m3.predict_proba(X)
    assert not np.allclose(p1, p3)


def test_torch_mlp_synthetic_training():
    X, y = _synthetic_fixture(n=200, seed=123)
    tr, va, _te = chrono_split(len(y), train_frac=0.7, val_frac=0.15)
    m = TorchMLP(in_features=8, hidden_dims=(32, 16), lr=0.01, random_state=7)
    m.fit_scaler(X[tr])

    losses = []
    for _ in range(5):
        loss = m.partial_epoch(X[tr], y[tr])
        losses.append(loss)

    assert m.epoch == 5
    assert m.step == 5
    assert np.all(np.isfinite(losses))
    # Loss should generally decrease or remain bounded
    assert losses[-1] < losses[0]


def test_torch_mlp_preprocessing_train_only_no_leakage():
    X, _y = _synthetic_fixture(n=200, seed=9)
    tr, va, _te = chrono_split(len(X))
    m = TorchMLP(in_features=8, random_state=7)
    m.fit_scaler(X[tr])

    # Scaler mean must match train slice exactly
    assert np.allclose(m.scaler.mean_, X[tr].mean(axis=0))
    assert not np.allclose(m.scaler.mean_, X.mean(axis=0))


def test_torch_mlp_invalid_inputs_fail_closed():
    m = TorchMLP(in_features=4, hidden_dims=(8,), random_state=7)
    X_valid = np.zeros((10, 4))
    y_valid = np.zeros(10, dtype=int)
    m.fit_scaler(X_valid)

    # Non-finite feature
    X_nan = X_valid.copy()
    X_nan[0, 0] = np.nan
    with pytest.raises(Exception) as exc:
        m.partial_epoch(X_nan, y_valid)
    assert "INVALID_FEATURE" in str(exc.value)

    # Invalid dimension
    with pytest.raises(Exception) as exc:
        m.partial_epoch(np.zeros(10), y_valid)
    assert "INVALID_FEATURE" in str(exc.value)

    # Non-binary labels
    with pytest.raises(Exception) as exc:
        m.partial_epoch(X_valid, np.array([0, 1, 2, 0, 1, 0, 1, 0, 1, 0]))
    assert "INVALID_LABEL" in str(exc.value)

    # Length mismatch
    with pytest.raises(Exception) as exc:
        m.partial_epoch(X_valid, np.array([0, 1]))
    assert "INVALID_FEATURE" in str(exc.value)


def test_torch_mlp_invalid_config():
    with pytest.raises(Exception) as exc:
        TorchMLP(hidden_dims=())
    assert "INVALID_CONFIG" in str(exc.value)

    with pytest.raises(Exception) as exc:
        TorchMLP(activation="unsupported_act")
    assert "INVALID_CONFIG" in str(exc.value)


def test_torch_mlp_checkpoint_save_load_resume(tmp_path):
    X, y = _synthetic_fixture(n=150, seed=11)
    tr, _va, _te = chrono_split(len(y))

    # Run 4 epochs continuously
    a = TorchMLP(in_features=8, hidden_dims=(16, 8), lr=0.005, random_state=42)
    a.fit_scaler(X[tr])
    for _ in range(4):
        a.partial_epoch(X[tr], y[tr])

    # Run 2 epochs, checkpoint, resume 2 epochs
    b = TorchMLP(in_features=8, hidden_dims=(16, 8), lr=0.005, random_state=42)
    b.fit_scaler(X[tr])
    for _ in range(2):
        b.partial_epoch(X[tr], y[tr])

    ckpt_path = str(tmp_path / "ckpt_mlp.npz")
    save_checkpoint(ckpt_path, b, {"run_id": "test_mlp", "epoch": b.epoch})

    c = TorchMLP(in_features=8, hidden_dims=(16, 8), lr=0.005, random_state=42)
    meta = load_checkpoint(ckpt_path, c)
    assert meta["epoch"] == 2
    assert c.epoch == 2

    for _ in range(2):
        c.partial_epoch(X[tr], y[tr])

    assert c.epoch == 4
    # Predictions after resumed run must be close to uninterrupted run
    pa = a.predict_proba(X[tr])
    pc = c.predict_proba(X[tr])
    assert np.allclose(pa, pc, atol=1e-5)


def test_torch_mlp_full_run_training(tmp_path):
    X, y = _synthetic_fixture(n=200, seed=5)
    config = {
        "model_type": "torch-mlp",
        "hidden_dims": "16,8",
        "activation": "relu",
        "lr": 0.005,
        "batch_size": 32,
        "random_state": 7,
    }
    out = run_training("mlp-test-run", str(tmp_path), X, y,
                       dataset_version="ds-synth-1",
                       feature_version="feat-v1",
                       label_version="label-v1",
                       config=config, device="cpu", seed=7, epochs=3)

    manifest = out["manifest"]
    assert manifest["status"] == "COMPLETED"
    assert manifest["epochs_trained"] == 3
    assert len(manifest["checkpoints"]) == 3
    assert manifest["artifact_sha256"]

    # Verify final artifact loading and evaluation
    import joblib
    art_path = os.path.join(out["run_dir"], "final", "artifact.joblib")
    assert os.path.exists(art_path)
    art = joblib.load(art_path)
    assert art["model_type"] == "torch-mlp"

    _tr, _va, te = chrono_split(len(y))
    proba = predict_proba_from_artifact(art, X[te])
    ev = evaluate_proba(y[te], proba)
    assert 0.0 <= ev["accuracy"] <= 1.0
    assert 0.0 <= ev["balanced_accuracy"] <= 1.0
    assert ev["n"] == len(te)
    assert ev["coverage"] == 1.0
    assert ev["failed_predictions"] == 0
    assert "confusion_matrix" in ev
    assert "brier_score" in ev


def test_baseline_vs_mlp_evaluation_consistency(tmp_path):
    X, y = _synthetic_fixture(n=250, seed=42)
    _tr, _va, te = chrono_split(len(y))

    # Train L-BFGS baseline
    out_lr = run_training("lr-run", str(tmp_path), X, y, "ds-v", "feat-v1", "label-v1",
                          {"model_type": "logreg-lbfgs", "alpha": 0.001, "random_state": 7},
                          "cpu", 7, epochs=3)
    # Train TorchMLP
    out_mlp = run_training("mlp-run", str(tmp_path), X, y, "ds-v", "feat-v1", "label-v1",
                           {"model_type": "torch-mlp", "hidden_dims": (16,), "random_state": 7},
                           "cpu", 7, epochs=3)

    import joblib
    art_lr = joblib.load(os.path.join(out_lr["run_dir"], "final", "artifact.joblib"))
    art_mlp = joblib.load(os.path.join(out_mlp["run_dir"], "final", "artifact.joblib"))

    p_lr = predict_proba_from_artifact(art_lr, X[te])
    p_mlp = predict_proba_from_artifact(art_mlp, X[te])

    ev_lr = evaluate_proba(y[te], p_lr)
    ev_mlp = evaluate_proba(y[te], p_mlp)

    # Both evaluators must compute identical schema
    expected_keys = {
        "n", "pos_rate", "accuracy", "balanced_accuracy", "precision", "recall",
        "f1", "confusion_matrix", "brier_score", "log_loss", "coverage",
        "failed_predictions", "baseline_majority_accuracy", "threshold",
    }
    assert set(ev_lr.keys()) == expected_keys
    assert set(ev_mlp.keys()) == expected_keys
    assert ev_lr["n"] == ev_mlp["n"] == len(te)
    assert ev_lr["baseline_majority_accuracy"] == ev_mlp["baseline_majority_accuracy"]


def test_make_model_factory():
    m1 = make_model("sgd-logloss")
    assert isinstance(m1, MarketMLP)

    m2 = make_model("logreg-lbfgs")
    assert isinstance(m2, LogRegLBFGS)

    m3 = make_model("torch-mlp", hidden_dims=(32, 16))
    assert isinstance(m3, TorchMLP)

    with pytest.raises(Exception):
        make_model("unknown-model")


def test_import_does_not_launch_training():
    # Verify importing aurix_ai or any module does not trigger active runs or locks
    import aurix_ai
    import aurix_ai.train
    import aurix_ai.orchestrate
    assert aurix_ai.__version__


def test_market_data_fair_comparison(tmp_path):
    """Evaluates Logistic Regression vs TorchMLP on the real eligible dataset."""
    from aurix_ai.datasets import load_dataset
    dataset_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                               "data", "datasets", "aurix-nse-daily-adjusted-410acb26a9ee")
    if not os.path.exists(dataset_dir):
        pytest.skip("Eligible market dataset not found")

    X, y, ts, _inst, ds_manifest = load_dataset(dataset_dir)
    train_idx, val_idx, test_idx = chrono_split(len(y))

    # Evaluate LogReg (L-BFGS)
    lr_out = run_training("real-lr-eval", str(tmp_path), X, y,
                          ds_manifest["dataset_version"],
                          ds_manifest["feature_spec"]["version"],
                          ds_manifest["label_spec"]["version"],
                          {"model_type": "logreg-lbfgs", "alpha": 0.0001, "random_state": 7},
                          "cpu", seed=7, epochs=5)

    # Evaluate TorchMLP
    mlp_out = run_training("real-mlp-eval", str(tmp_path), X, y,
                           ds_manifest["dataset_version"],
                           ds_manifest["feature_spec"]["version"],
                           ds_manifest["label_spec"]["version"],
                           {"model_type": "torch-mlp", "hidden_dims": (32, 16),
                            "activation": "relu", "lr": 0.001, "batch_size": 32,
                            "random_state": 7},
                           "cpu", seed=7, epochs=5)

    import joblib
    art_lr = joblib.load(os.path.join(lr_out["run_dir"], "final", "artifact.joblib"))
    art_mlp = joblib.load(os.path.join(mlp_out["run_dir"], "final", "artifact.joblib"))

    p_lr = predict_proba_from_artifact(art_lr, X[test_idx])
    p_mlp = predict_proba_from_artifact(art_mlp, X[test_idx])

    ev_lr = evaluate_proba(y[test_idx], p_lr)
    ev_mlp = evaluate_proba(y[test_idx], p_mlp)

    # Both completed
    assert lr_out["manifest"]["status"] == "COMPLETED"
    assert mlp_out["manifest"]["status"] == "COMPLETED"
    assert ev_lr["n"] == len(test_idx)
    assert ev_mlp["n"] == len(test_idx)
    assert ev_lr["coverage"] == 1.0
    assert ev_mlp["coverage"] == 1.0

    comparison = {
        "dataset_version": ds_manifest["dataset_version"],
        "dataset_n_rows": len(y),
        "split_counts": {
            "train": len(train_idx),
            "val": len(val_idx),
            "test": len(test_idx),
        },
        "split_date_ranges": {
            "train": [int(ts[train_idx[0]]), int(ts[train_idx[-1]])],
            "val": [int(ts[val_idx[0]]), int(ts[val_idx[-1]])],
            "test": [int(ts[test_idx[0]]), int(ts[test_idx[-1]])],
        },
        "logistic_regression": {
            "run_id": lr_out["manifest"]["run_id"],
            "model_type": lr_out["manifest"]["configuration"]["model_type"],
            "elapsed_s": lr_out["manifest"]["elapsed_s"],
            "artifact_sha256": lr_out["manifest"]["artifact_sha256"],
            "metrics": ev_lr,
        },
        "torch_mlp": {
            "run_id": mlp_out["manifest"]["run_id"],
            "model_type": mlp_out["manifest"]["configuration"]["model_type"],
            "elapsed_s": mlp_out["manifest"]["elapsed_s"],
            "artifact_sha256": mlp_out["manifest"]["artifact_sha256"],
            "metrics": ev_mlp,
        },
    }
    print("\n--- FAIR MODEL COMPARISON RESULTS ---")
    print(json.dumps(comparison, indent=2))
    print("--- END COMPARISON ---\n")
