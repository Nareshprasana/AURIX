"""Training orchestration: manifests, metrics, checkpoints, artifacts, evaluation.

Every run lives in an isolated directory:
  <out>/<run_id>/manifest.json, metrics.jsonl, checkpoints/checkpoint-XXXX.npz,
  final/artifact.joblib + artifact.json, knowledge_refs.jsonl
Resume continues the same run directory (never overwrites checkpoints).
"""

from __future__ import annotations

import hashlib
import json
import os
import time

import numpy as np

from . import __version__ as CODE_VERSION
from .datasets import chrono_split
from .errors import fail
from .model import load_checkpoint, save_checkpoint


def _gpu_snapshot() -> dict:
    try:
        from .resources import detect_resources
        rep = detect_resources()
        return {"present": rep.gpu_present, "name": rep.gpu_name,
                "vram_total_mb": rep.vram_total_mb, "vram_used_mb": rep.vram_used_mb,
                "torch_cuda": rep.torch_cuda_available,
                "torch_version": rep.torch_version}
    except Exception:
        return {"present": False}


def _framework_versions() -> dict:
    out = {}
    for mod in ("sklearn", "numpy", "joblib", "torch", "laya"):
        try:
            m = __import__(mod)
            out[mod] = str(getattr(m, "__version__", "present"))
        except Exception:
            out[mod] = None
    return out


def _sha_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def evaluate_proba(y_true: np.ndarray, proba: np.ndarray, threshold: float = 0.5) -> dict:
    from sklearn.metrics import (accuracy_score, precision_score, recall_score,
                                 balanced_accuracy_score, f1_score, confusion_matrix,
                                 brier_score_loss, log_loss)
    proba_arr = np.asarray(proba, dtype=float)
    if proba_arr.ndim == 2:
        proba_arr = proba_arr[:, 1]
    y_arr = np.asarray(y_true, dtype=int).ravel()

    valid_mask = np.isfinite(proba_arr)
    coverage = float(np.mean(valid_mask)) if len(proba_arr) > 0 else 0.0
    failed_predictions = int(np.sum(~valid_mask))
    if not np.all(valid_mask):
        proba_arr = np.nan_to_num(proba_arr, nan=0.5)

    pred = (proba_arr >= threshold).astype(int)
    majority = 1 if np.mean(y_arr) >= 0.5 else 0
    base_acc = float(np.mean(y_arr == majority))

    clipped_proba = np.clip(proba_arr, 1e-15, 1.0 - 1e-15)
    loss_val = float(log_loss(y_arr, clipped_proba, labels=[0, 1]))
    brier = float(brier_score_loss(y_arr, proba_arr))
    cm = confusion_matrix(y_arr, pred, labels=[0, 1]).tolist()

    return {
        "n": int(len(y_arr)),
        "pos_rate": float(np.mean(y_arr)),
        "accuracy": float(accuracy_score(y_arr, pred)),
        "balanced_accuracy": float(balanced_accuracy_score(y_arr, pred)),
        "precision": float(precision_score(y_arr, pred, zero_division=0)),
        "recall": float(recall_score(y_arr, pred, zero_division=0)),
        "f1": float(f1_score(y_arr, pred, zero_division=0)),
        "confusion_matrix": cm,
        "brier_score": brier,
        "log_loss": loss_val,
        "coverage": coverage,
        "failed_predictions": failed_predictions,
        "baseline_majority_accuracy": base_acc,
        "threshold": threshold,
    }


def base_rate_loss(y: np.ndarray) -> float:
    """Log-loss of the constant base-rate predictor. The honest floor any
    trained model must beat; used for convergence and diagnosis."""
    from sklearn.metrics import log_loss
    y = np.asarray(y)
    p = float(np.mean(y)) if len(y) else 0.5
    p = min(max(p, 1e-12), 1.0 - 1e-12)
    return float(log_loss(y, np.full_like(y, p, dtype=float), labels=[0, 1]))


def diagnose_run(train_loss: float, val_loss: float, base_loss: float,
                 n: int) -> dict:
    """Classify a completed run. Thresholds are documented and conservative;
    they describe fit quality, never profitability.

    - FAILED: non-finite losses (numerical breakdown).
    - UNDERFIT: train loss far above the base-rate floor (model learned little).
    - OVERFIT: train far below val (memorized train, generalized poorly).
    - INCONCLUSIVE: too few samples to judge.
    - CONVERGED: train near/below base-rate with a contained train/val gap.
    """
    import math
    if not (math.isfinite(train_loss) and math.isfinite(val_loss)
            and math.isfinite(base_loss)):
        return {"verdict": "FAILED", "detail": "non-finite loss"}
    if n < 30:
        return {"verdict": "INCONCLUSIVE", "detail": f"n={n} below minimum 30"}
    if train_loss > 1.5 * base_loss:
        return {"verdict": "UNDERFIT",
                "detail": f"train {train_loss:.4f} far above base-rate {base_loss:.4f}"}
    if val_loss - train_loss > max(0.5 * abs(train_loss), 0.2):
        return {"verdict": "OVERFIT",
                "detail": f"train {train_loss:.4f} vs val {val_loss:.4f}: large generalization gap"}
    if abs(val_loss - base_loss) < 0.05 and abs(train_loss - base_loss) < 0.05:
        return {"verdict": "INCONCLUSIVE",
                "detail": "losses indistinguishable from base rate"}
    return {"verdict": "CONVERGED",
            "detail": f"train {train_loss:.4f} vs base {base_loss:.4f}"}


def run_training(run_id: str, out_root: str, X: np.ndarray, y: np.ndarray,
                 dataset_version: str, feature_version: str, label_version: str,
                 config: dict, device: str, seed: int, epochs: int,
                 start_epoch: int = 0, model=None,
                 resume_from: str | None = None) -> dict:
    t0 = time.time()
    run_dir = os.path.join(out_root, run_id)
    resuming = resume_from is not None or start_epoch > 0 or model is not None
    os.makedirs(os.path.join(run_dir, "checkpoints"), exist_ok=True)
    os.makedirs(os.path.join(run_dir, "final"), exist_ok=True)
    train_idx, val_idx, _ = chrono_split(len(y))
    model_type = config.get("model_type", "sgd-logloss")
    patience = int(config.get("early_stopping_patience", 0))
    from .model import make_model
    model_kwargs = {k: v for k, v in config.items() if k not in ("alpha", "random_state", "lbfgs_max_iter", "model_type", "early_stopping_patience")}
    if resume_from:
        if model is None:
            model = make_model(model_type, alpha=config.get("alpha", 0.0001),
                               random_state=config.get("random_state", seed),
                               max_iter=int(config.get("lbfgs_max_iter", 1000)),
                               **model_kwargs)
        ckpt_meta = load_checkpoint(resume_from, model)
        start_epoch = int(ckpt_meta["epoch"])
    elif model is None:
        model = make_model(model_type, alpha=config.get("alpha", 0.0001),
                           random_state=config.get("random_state", seed),
                           max_iter=int(config.get("lbfgs_max_iter", 1000)),
                           **model_kwargs)
        model.fit_scaler(X[train_idx])
    # else: caller-supplied model already holds checkpointed state (resume);
    # scaler must NOT be refit (train-only stats preserved).
    metrics_path = os.path.join(run_dir, "metrics.jsonl")
    steps = 0
    best_val = None
    stale_epochs = 0
    early_stopped = False
    for ep in range(start_epoch + 1, start_epoch + epochs + 1):
        train_loss = model.partial_epoch(X[train_idx], y[train_idx])
        val_proba = model.predict_proba(X[val_idx])[:, 1]
        from sklearn.metrics import log_loss
        val_loss = float(log_loss(y[val_idx], val_proba, labels=[0, 1]))
        row = {"epoch": ep, "step": model.step, "train_loss": train_loss,
               "val_loss": val_loss, "elapsed_s": round(time.time() - t0, 2)}
        with open(metrics_path, "a") as f:
            f.write(json.dumps(row) + "\n")
        ckpt = os.path.join(run_dir, "checkpoints", f"checkpoint-{ep:04d}.npz")
        if not os.path.exists(ckpt):
            save_checkpoint(ckpt, model, {
                "run_id": run_id, "epoch": ep, "dataset_version": dataset_version,
                "feature_version": feature_version, "label_version": label_version,
                "seed": seed, "config": config,
            })
        steps += 1
        # Early stopping on VALIDATION loss only (never the test split).
        # patience=0 preserves legacy fixed-epoch behavior exactly.
        if patience > 0:
            if best_val is None or val_loss < best_val - 1e-9:
                best_val, stale_epochs = val_loss, 0
            else:
                stale_epochs += 1
                if stale_epochs >= patience:
                    early_stopped = True
                    break
    # Final artifact (immutable; refuse overwrite on mismatch).
    import joblib
    art_path = os.path.join(run_dir, "final", "artifact.joblib")
    if hasattr(model, "to_artifact_payload"):
        payload = model.to_artifact_payload()
    else:
        payload = {"coef": model.clf.coef_, "intercept": model.clf.intercept_,
                   "scaler_mean": model.scaler.mean_, "scaler_var": model.scaler.var_,
                   "alpha": getattr(model, "alpha", 0.0001), "classes": model.classes_,
                   "solver": "lbfgs" if model_type == "logreg-lbfgs" else "sgd"}
    if os.path.exists(art_path) and not resuming:
        raise fail("INVALID_CONFIG", "final artifact exists (immutable)")
    if os.path.exists(art_path) and resuming:
        os.remove(art_path)
    joblib.dump(payload, art_path)
    base_loss = base_rate_loss(y[train_idx])
    with open(metrics_path) as _mf:
        _rows = [json.loads(l) for l in _mf if l.strip()]
    diagnosis = diagnose_run(_rows[-1]["train_loss"], _rows[-1]["val_loss"],
                             base_loss, len(y[train_idx]))
    manifest = {
        "run_id": run_id, "model_id": f"aurix-marketml-{run_id}",
        "model_version": "candidate-v1", "dataset_version": dataset_version,
        "feature_version": feature_version, "label_version": label_version,
        "code_version": CODE_VERSION,
        "configuration": config,
        "configuration_hash": hashlib.sha256(
            json.dumps(config, sort_keys=True).encode()).hexdigest()[:16],
        "random_seed": seed, "device": device,
        "gpu": _gpu_snapshot(),
        "python_version": __import__("sys").version.split()[0],
        "framework_versions": _framework_versions(),
        "started_at": int((t0) * 1000), "ended_at": int(time.time() * 1000),
        "epochs_trained": model.epoch, "steps": model.step,
        "early_stopped": early_stopped,
        "converged": bool(getattr(model, "converged", False)),
        "base_rate_loss": base_loss,
        "diagnosis": diagnosis,
        "status": "COMPLETED", "elapsed_s": round(time.time() - t0, 2),
        "checkpoints": sorted(os.listdir(os.path.join(run_dir, "checkpoints"))),
        "artifact": os.path.basename(art_path),
        "artifact_sha256": _sha_file(art_path),
    }
    with open(os.path.join(run_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    # Import-ready knowledge refs (OBSERVATIONs; never auto-committed).
    with open(os.path.join(run_dir, "knowledge_refs.jsonl"), "a") as f:
        f.write(json.dumps({"assertion": "OBSERVATION", "kind": "training-run",
                            "refs": {"run_id": run_id, "dataset_version": dataset_version,
                                     "epochs": model.epoch}}) + "\n")
    return {"run_dir": run_dir, "manifest": manifest, "model": model,
            "train_idx": train_idx, "val_idx": val_idx, "steps": steps}


def walk_forward_cv(
    X: np.ndarray,
    y: np.ndarray,
    model_type: str = "logreg-lbfgs",
    model_config: dict | None = None,
    n_windows: int = 4,
    train_bars: int = 60,
    test_bars: int = 20,
    step_bars: int = 20,
    purge_bars: int = 0,
    epochs: int = 5,
    seed: int = 7,
) -> dict:
    """Strictly forward-only rolling walk-forward cross validation.

    Ensures zero future-leakage:
      - Chronological window slicing: train precedes test.
      - Scaler fitting occurs ONLY on the training slice for each window.
      - Optional purge_bars buffer between train and test windows.
      - Predicts and evaluates strictly out-of-sample on unseen test bars.
    """
    X_arr = np.asarray(X, dtype=float)
    y_arr = np.asarray(y, dtype=int).ravel()
    n_samples = len(y_arr)
    if n_samples == 0 or len(X_arr) != n_samples:
        raise fail("INVALID_CONFIG", "X and y must be non-empty and equal length")
    if train_bars <= 0 or test_bars <= 0 or step_bars <= 0 or n_windows <= 0:
        raise fail("INVALID_CONFIG", "bar parameters and n_windows must be positive")
    if purge_bars < 0:
        raise fail("INVALID_CONFIG", "purge_bars must be non-negative")

    min_required = train_bars + purge_bars + test_bars
    if n_samples < min_required:
        raise fail("INVALID_CONFIG", f"insufficient samples for walk-forward CV: {n_samples} < {min_required}")

    from .model import make_model
    cfg = dict(model_config or {})
    model_kwargs = {k: v for k, v in cfg.items() if k not in ("alpha", "random_state", "lbfgs_max_iter", "model_type", "early_stopping_patience")}

    windows = []
    for w in range(n_windows):
        train_start = w * step_bars
        train_end = train_start + train_bars
        test_start = train_end + purge_bars
        test_end = test_start + test_bars

        if test_end > n_samples:
            break

        X_tr = X_arr[train_start:train_end]
        y_tr = y_arr[train_start:train_end]
        X_te = X_arr[test_start:test_end]
        y_te = y_arr[test_start:test_end]

        # Check binary labels present in training split
        unique_labels = np.unique(y_tr)
        if len(unique_labels) < 2:
            # Skip degenerate windows where training fold has only one class
            continue

        model = make_model(
            model_type,
            alpha=cfg.get("alpha", 0.0001),
            random_state=cfg.get("random_state", seed + w),
            max_iter=int(cfg.get("lbfgs_max_iter", 1000)),
            **model_kwargs,
        )

        # STRICT ISOLATION: fit preprocessing scaler ONLY on train slice
        model.fit_scaler(X_tr)

        for _ in range(epochs):
            model.partial_epoch(X_tr, y_tr)

        proba = model.predict_proba(X_te)
        metrics = evaluate_proba(y_te, proba)
        edge = metrics["accuracy"] - metrics["baseline_majority_accuracy"]
        metrics["window_idx"] = w
        metrics["train_range"] = [int(train_start), int(train_end)]
        metrics["test_range"] = [int(test_start), int(test_end)]
        metrics["edge"] = edge
        windows.append(metrics)

    if not windows:
        raise fail("INVALID_CONFIG", "no valid walk-forward windows could be evaluated")

    edges = [w["edge"] for w in windows]
    accuracies = [w["accuracy"] for w in windows]
    balanced_accs = [w["balanced_accuracy"] for w in windows]
    f1s = [w["f1"] for w in windows]
    briers = [w["brier_score"] for w in windows]
    log_losses = [w["log_loss"] for w in windows]

    return {
        "model_type": model_type,
        "n_windows": len(windows),
        "mean_accuracy": float(np.mean(accuracies)),
        "median_accuracy": float(np.median(accuracies)),
        "mean_edge": float(np.mean(edges)),
        "median_edge": float(np.median(edges)),
        "mean_balanced_accuracy": float(np.mean(balanced_accs)),
        "mean_f1": float(np.mean(f1s)),
        "mean_brier_score": float(np.mean(briers)),
        "mean_log_loss": float(np.mean(log_losses)),
        "windows": windows,
    }

