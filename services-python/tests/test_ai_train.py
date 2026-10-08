"""AI training tests: init, real parameter updates, checkpoint load, resume
equality, artifact load, inference, scaler train-only fitting."""

import numpy as np

from aurix_ai.datasets import build_features_labels, chrono_split, generate_ohlcv
from aurix_ai.model import MarketMLP, load_checkpoint, save_checkpoint
from aurix_ai.train import evaluate_proba, run_training


def _data():
    bars = generate_ohlcv(7, 400, ("A", "B"), 1700000000000)
    return build_features_labels(bars, 5, 0.005)[:4]


def test_real_parameter_updates(tmp_path):
    X, y, _ts, _inst = _data()
    tr, _va, _te = chrono_split(len(y))
    m = MarketMLP()
    m.fit_scaler(X[tr])
    before = m.clf.coef_.copy() if hasattr(m.clf, "coef_") else None
    loss1 = m.partial_epoch(X[tr], y[tr])
    loss2 = m.partial_epoch(X[tr], y[tr])
    assert np.isfinite(loss1) and np.isfinite(loss2)
    assert not np.allclose(m.clf.coef_, np.zeros_like(m.clf.coef_))
    assert m.epoch == 2 and m.step == 2


def test_scaler_train_only():
    X, y, _ts, _inst = _data()
    tr, va, _te = chrono_split(len(y))
    m = MarketMLP()
    m.fit_scaler(X[tr])
    # Scaler stats equal train slice stats (no validation leakage).
    assert np.allclose(m.scaler.mean_, X[tr].mean(axis=0))
    leaked = MarketMLP()
    leaked.fit_scaler(X[np.concatenate([tr, va])])
    assert not np.allclose(leaked.scaler.mean_, m.scaler.mean_)


def test_checkpoint_resume_equality(tmp_path):
    X, y, _ts, _inst = _data()
    tr, _va, _te = chrono_split(len(y))
    # Continuous 4-epoch run.
    a = MarketMLP()
    a.fit_scaler(X[tr])
    for _ in range(4):
        a.partial_epoch(X[tr], y[tr])
    # 2 epochs -> checkpoint -> fresh model -> resume 2 epochs.
    b = MarketMLP()
    b.fit_scaler(X[tr])
    for _ in range(2):
        b.partial_epoch(X[tr], y[tr])
    ckpt = str(tmp_path / "ckpt.npz")
    save_checkpoint(ckpt, b, {"run_id": "t", "epoch": b.epoch})
    c = MarketMLP()
    meta = load_checkpoint(ckpt, c)
    assert meta["epoch"] == 2 and c.epoch == 2
    for _ in range(2):
        c.partial_epoch(X[tr], y[tr])
    assert c.epoch == 4
    assert np.allclose(c.clf.coef_, a.clf.coef_)
    assert np.allclose(c.clf.intercept_, a.clf.intercept_)


def test_full_run_artifact_inference(tmp_path):
    X, y, _ts, _inst = _data()
    out = run_training("test-run", str(tmp_path), X, y, "ds-v", "feat-v1",
                       "label-v1", {"alpha": 0.0001, "random_state": 7},
                       "cpu", 7, epochs=3)
    assert out["manifest"]["status"] == "COMPLETED"
    assert len(out["manifest"]["checkpoints"]) == 3
    assert out["manifest"]["artifact_sha256"]
    import joblib
    art = joblib.load(f"{out['run_dir']}/final/artifact.joblib")
    assert art["coef"].shape[1] == X.shape[1]
    _tr, _va, te = chrono_split(len(y))
    scale = np.sqrt(np.maximum(art["scaler_var"], 1e-12))
    proba = 1.0 / (1.0 + np.exp(-((X[te] - art["scaler_mean"]) / scale @ art["coef"].T + art["intercept"]).ravel()))
    ev = evaluate_proba(y[te], proba)
    assert 0.0 <= ev["accuracy"] <= 1.0 and ev["n"] == len(te)
