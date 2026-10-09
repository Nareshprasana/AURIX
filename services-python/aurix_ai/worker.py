"""Training worker: runs INSIDE an independent process spawned by the scheduler.

Writes ONLY its own experiment dir. Heartbeats so the scheduler can track,
detect death, and resume from the latest immutable checkpoint. Reuses
run_training() — no training logic duplicated here.
"""

from __future__ import annotations

import glob
import json
import os
import threading
import time

from .orchestrate import emit_event, utc_ms


def _epoch_from_metrics(exp_dir: str) -> int:
    path = os.path.join(exp_dir, "metrics.jsonl")
    if not os.path.exists(path):
        return 0
    try:
        with open(path) as f:
            lines = [l for l in f.read().strip().split("\n") if l.strip()]
        return int(json.loads(lines[-1]).get("epoch", 0)) if lines else 0
    except Exception:
        return 0


def _latest_ckpt(exp_dir: str) -> str | None:
    ckpts = sorted(glob.glob(os.path.join(exp_dir, "checkpoints", "*.npz")))
    return os.path.basename(ckpts[-1]) if ckpts else None


def heartbeat_loop(exp_dir: str, exp_id: str, stop: threading.Event, mode: str):
    path = os.path.join(exp_dir, "heartbeat.json")
    while not stop.wait(5):
        try:
            with open(path, "w") as f:
                json.dump({"pid": os.getpid(), "ts": utc_ms(),
                           "epoch": _epoch_from_metrics(exp_dir),
                           "checkpoint": _latest_ckpt(exp_dir),
                           "status": "running", "mode": mode}, f)
        except Exception:
            pass


def run_worker(exp_dir: str, resume: bool = False) -> int:
    from .datasets import load_dataset
    from .model import MarketMLP
    from .train import run_training
    with open(os.path.join(exp_dir, "experiment.json")) as f:
        exp = json.load(f)
    eid = exp["experiment_id"]
    defn = exp["definition"]
    stop = threading.Event()
    t = threading.Thread(target=heartbeat_loop, args=(exp_dir, eid, stop,
                                                     "resume" if resume else "fresh"),
                         daemon=True)
    t.start()
    failed = None
    try:
        X, y, _ts, _inst, ds = load_dataset(defn["dataset_dir"])
        cfg = dict(defn.get("hyperparameters", {}))
        model = None
        resume_from = None
        epochs_left = int(defn["epochs"])
        if resume:
            ckpts = sorted(glob.glob(os.path.join(exp_dir, "checkpoints", "*.npz")))
            if ckpts:
                from .model import load_checkpoint
                model = MarketMLP()
                meta = load_checkpoint(ckpts[-1], model)
                epochs_left = max(0, int(defn["epochs"]) - int(meta.get("epoch", 0)))
                resume_from = None  # state already loaded; run_training must NOT refit scaler
        out = run_training(eid, os.path.dirname(exp_dir.rstrip("/\\")), X, y,
                           ds["dataset_version"], ds["feature_spec"]["version"],
                           ds["label_spec"]["version"], cfg,
                           defn.get("device", "cpu"),
                           seed=int(defn.get("seed", 7)),
                           epochs=epochs_left,
                           start_epoch=(model.epoch if model else 0), model=model,
                           resume_from=resume_from)
        emit_event(exp_dir, eid, "CHECKPOINT_CREATED",
                   {"checkpoints": out["manifest"]["checkpoints"]})
        return 0
    except Exception as e:
        failed = str(e)
        emit_event(exp_dir, eid, "TRAINING_FAILED", {"error": str(e)})
        return 1
    finally:
        stop.set()
        try:
            hb_path = os.path.join(exp_dir, "heartbeat.json")
            hb = {}
            if os.path.exists(hb_path):
                hb = json.load(open(hb_path))
            hb.update({"pid": os.getpid(), "ts": utc_ms(),
                       "epoch": _epoch_from_metrics(exp_dir),
                       "checkpoint": _latest_ckpt(exp_dir),
                       "status": "failed" if failed else "done"})
            if failed:
                hb["error"] = failed
            json.dump(hb, open(hb_path, "w"))
        except Exception:
            pass
