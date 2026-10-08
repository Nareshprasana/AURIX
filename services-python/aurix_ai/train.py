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
from .model import MarketMLP, load_checkpoint, save_checkpoint


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
    from sklearn.metrics import accuracy_score, precision_score, recall_score
    pred = (proba >= threshold).astype(int)
    majority = 1 if np.mean(y_true) >= 0.5 else 0
    base_acc = float(np.mean(y_true == majority))
    return {
        "n": int(len(y_true)),
        "pos_rate": float(np.mean(y_true)),
        "accuracy": float(accuracy_score(y_true, pred)),
        "precision": float(precision_score(y_true, pred, zero_division=0)),
        "recall": float(recall_score(y_true, pred, zero_division=0)),
        "baseline_majority_accuracy": base_acc,
        "threshold": threshold,
    }


def run_training(run_id: str, out_root: str, X: np.ndarray, y: np.ndarray,
                 dataset_version: str, feature_version: str, label_version: str,
                 config: dict, device: str, seed: int, epochs: int,
                 start_epoch: int = 0, model: MarketMLP | None = None,
                 resume_from: str | None = None) -> dict:
    t0 = time.time()
    run_dir = os.path.join(out_root, run_id)
    resuming = resume_from is not None or start_epoch > 0 or model is not None
    os.makedirs(os.path.join(run_dir, "checkpoints"), exist_ok=True)
    os.makedirs(os.path.join(run_dir, "final"), exist_ok=True)
    train_idx, val_idx, _ = chrono_split(len(y))
    if resume_from:
        if model is None:
            model = MarketMLP(alpha=config.get("alpha", 0.0001),
                              random_state=config.get("random_state", seed))
        ckpt_meta = load_checkpoint(resume_from, model)
        start_epoch = int(ckpt_meta["epoch"])
    elif model is None:
        model = MarketMLP(alpha=config.get("alpha", 0.0001),
                          random_state=config.get("random_state", seed))
        model.fit_scaler(X[train_idx])
    # else: caller-supplied model already holds checkpointed state (resume);
    # scaler must NOT be refit (train-only stats preserved).
    metrics_path = os.path.join(run_dir, "metrics.jsonl")
    steps = 0
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
    # Final artifact (immutable; refuse overwrite on mismatch).
    import joblib
    art_path = os.path.join(run_dir, "final", "artifact.joblib")
    payload = {"coef": model.clf.coef_, "intercept": model.clf.intercept_,
               "scaler_mean": model.scaler.mean_, "scaler_var": model.scaler.var_,
               "alpha": model.alpha, "classes": model.classes_}
    if os.path.exists(art_path) and not resuming:
        raise fail("INVALID_CONFIG", "final artifact exists (immutable)")
    if os.path.exists(art_path) and resuming:
        os.remove(art_path)
    joblib.dump(payload, art_path)
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
