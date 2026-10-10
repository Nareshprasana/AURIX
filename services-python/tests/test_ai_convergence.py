"""Training convergence (P1-2): solver fit-to-convergence, early stopping on
VAL only, run diagnosis, no test-set influence. Deterministic synthetic
fixtures; no market data, no training of production models."""

import numpy as np


def _separable(n=400, seed=7):
    rng = np.random.default_rng(seed)
    X = rng.normal(0, 1, size=(n, 4))
    y = (X[:, 0] + 0.5 * X[:, 1] > 0).astype(int)
    return X, y


def test_lbfgs_converges_on_separable_fixture(tmp_path):
    from aurix_ai.model import LogRegLBFGS, make_model
    X, y = _separable()
    m = make_model("logreg-lbfgs", alpha=0.0001, random_state=7, max_iter=1000)
    assert isinstance(m, LogRegLBFGS)
    m.fit_scaler(X[:240])
    loss = m.fit(X[:240], y[:240])
    assert m.converged is True
    from sklearn.metrics import log_loss
    base = float(log_loss(y[:240], np.full(240, y[:240].mean()), labels=[0, 1]))
    assert loss < base * 0.7
    proba = m.predict_proba(X[240:300])[:, 1]
    assert float(((proba >= 0.5).astype(int) == y[240:300]).mean()) > 0.85


def test_make_model_rejects_unknown_solver():
    from aurix_ai.model import make_model
    import pytest
    with pytest.raises(Exception):
        make_model("llm-oracle")


def test_early_stopping_uses_val_only(tmp_path):
    from aurix_ai.train import run_training
    X, y = _separable(n=300)
    out = run_training("es-run", str(tmp_path), X, y, "ds-v", "feat-v1",
                       "label-v1", {"alpha": 0.0001, "random_state": 7,
                                    "model_type": "sgd-logloss",
                                    "early_stopping_patience": 2},
                       "cpu", 7, epochs=50)
    assert out["manifest"]["early_stopped"] is True
    assert out["manifest"]["epochs_trained"] < 50
    # Metrics rows carry train/val only — never test rows.
    import json
    rows = [json.loads(l) for l in
            open(f"{out['run_dir']}/metrics.jsonl").read().strip().split("\n")]
    assert rows and set(rows[0]) == {"epoch", "step", "train_loss", "val_loss", "elapsed_s"}


def test_legacy_default_runs_all_epochs(tmp_path):
    from aurix_ai.train import run_training
    X, y = _separable(n=300)
    out = run_training("legacy-run", str(tmp_path), X, y, "ds-v", "feat-v1",
                       "label-v1", {"alpha": 0.0001, "random_state": 7},
                       "cpu", 7, epochs=4)
    assert out["manifest"]["early_stopped"] is False
    assert out["manifest"]["epochs_trained"] == 4


def test_diagnose_run_verdicts():
    from aurix_ai.train import base_rate_loss, diagnose_run
    assert diagnose_run(5.8, 6.6, 0.69, 855)["verdict"] == "UNDERFIT"
    assert diagnose_run(0.2, 1.5, 0.69, 855)["verdict"] == "OVERFIT"
    assert diagnose_run(0.6, 0.65, 0.69, 855)["verdict"] == "CONVERGED"
    assert diagnose_run(0.6, 0.65, 0.69, 10)["verdict"] == "INCONCLUSIVE"
    assert diagnose_run(float("nan"), 0.6, 0.69, 855)["verdict"] == "FAILED"
    y = np.array([1] * 45 + [0] * 55)
    assert abs(base_rate_loss(y) - 0.688) < 0.01


def test_lbfgs_checkpoint_resume_and_manifest(tmp_path):
    from aurix_ai.model import load_checkpoint, make_model
    from aurix_ai.train import run_training
    X, y = _separable(n=300)
    out = run_training("lbfgs-run", str(tmp_path), X, y, "ds-v", "feat-v1",
                       "label-v1", {"alpha": 0.0001, "random_state": 7,
                                    "model_type": "logreg-lbfgs",
                                    "lbfgs_max_iter": 500},
                       "cpu", 7, epochs=3)
    m = out["manifest"]
    assert m["converged"] is True
    assert m["diagnosis"]["verdict"] in ("CONVERGED", "INCONCLUSIVE")
    assert m["artifact_sha256"]
    ckpt = f"{out['run_dir']}/checkpoints/checkpoint-0001.npz"
    m2 = make_model("logreg-lbfgs")
    meta = load_checkpoint(ckpt, m2)
    assert meta["epoch"] == 1
    assert float(((m2.predict_proba(X)[:, 1] >= 0.5).astype(int) == y).mean()) > 0.8
