"""TrainingState tests: schema, progress, worker info, pipeline, stall logic.
Temp roots + fixture state only; no training, no subprocesses, no network."""

import json
import os
import time

from aurix_ai.orchestrate import ExperimentRegistry
from aurix_ai.state import (STATE_FIELDS, build_state, detect_and_record_stall,
                            is_stalled, pipeline_for)


def _exp(root, status="RUNNING", heartbeat=None, metrics=(), events=(),
         definition=None, manifest=False, seed=7):
    reg = ExperimentRegistry(root)
    ds = os.path.join(root, "ds")
    os.makedirs(ds, exist_ok=True)
    definition = definition or {"dataset_dir": ds, "dataset_version": "ds-v",
                                "model_type": "sgd-logloss",
                                "hyperparameters": {"alpha": 0.0001},
                                "seed": seed, "epochs": 4, "device": "cpu"}
    rec = reg.submit(definition)
    eid, edir = rec["experiment_id"], os.path.join(root, rec["experiment_id"])
    if status != "QUEUED":
        reg.transition(eid, status, "test")
    if heartbeat is not None:
        with open(os.path.join(edir, "heartbeat.json"), "w") as f:
            json.dump(heartbeat, f)
    if metrics:
        with open(os.path.join(edir, "metrics.jsonl"), "w") as f:
            for m in metrics:
                f.write(json.dumps(m) + "\n")
    if events:
        with open(os.path.join(edir, "events.jsonl"), "w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")
    if manifest:
        with open(os.path.join(edir, "manifest.json"), "w") as f:
            json.dump({"status": "COMPLETED"}, f)
    with open(os.path.join(edir, "worker.log"), "w") as f:
        f.write("epoch 1 done\n")
    return eid, edir


def _now():
    return int(time.time() * 1000)


def test_idle_state(tmp_path):
    from aurix_ai.state import build_state
    st = build_state(str(tmp_path), _now())
    assert st["health"] == "IDLE" and st["experiment_id"] is None


def test_schema_keys_present(tmp_path):
    eid, edir = _exp(str(tmp_path), heartbeat={"pid": 111, "ts": _now(),
                                               "epoch": 1, "checkpoint": "checkpoint-0001.npz",
                                               "status": "running"},
                     metrics=[{"epoch": 1, "train_loss": 0.7, "val_loss": 0.72}])
    st = build_state(str(tmp_path), _now())
    assert all(k in st for k in STATE_FIELDS)
    assert st["experiment_id"] == eid
    assert st["worker_name"] == "training-worker" and st["worker_pid"] == 111
    assert st["epoch"] == 1 and st["total_epochs"] == 4
    assert st["progress"] == 0.25
    assert st["loss"] == 0.7 and st["validation_loss"] == 0.72
    assert st["checkpoint"] == "checkpoint-0001.npz"
    assert st["health"] == "RUNNING"
    assert st["heartbeat_age_seconds"] is not None


def test_stalled_detection_and_event(tmp_path):
    eid, edir = _exp(str(tmp_path), heartbeat={"pid": 99999999, "ts": 1, "epoch": 2,
                                               "checkpoint": "checkpoint-0002.npz",
                                               "status": "running"})
    st = build_state(str(tmp_path), _now(), stall_after_s=600)
    assert is_stalled(st) and st["health"] == "STALLED"
    assert "stale" in (st["error"] or "")
    ev = detect_and_record_stall(str(tmp_path), 600)
    assert ev and ev["type"] == "training.stalled"
    assert detect_and_record_stall(str(tmp_path), 600) is None  # no spam


def test_starting_before_first_heartbeat(tmp_path):
    eid, edir = _exp(str(tmp_path))  # RUNNING, no heartbeat yet
    st = build_state(str(tmp_path), _now())
    assert st["health"] == "STARTING"


def test_pipeline_stages(tmp_path):
    eid, edir = _exp(str(tmp_path), status="QUEUED")
    stages = {s["stage"]: s["state"] for s in pipeline_for(edir, "QUEUED")}
    assert stages["dataset"] == "RUNNING" and stages["training"] == "PENDING"
    eid2, edir2 = _exp(str(tmp_path), status="EVALUATED", manifest=True, seed=11)
    stages2 = {s["stage"]: s["state"] for s in pipeline_for(edir2, "EVALUATED")}
    assert stages2["training"] == "PASSED" and stages2["backtest"] == "RUNNING"


def test_failure_reason_from_events(tmp_path):
    eid, edir = _exp(str(tmp_path), status="FAILED")
    with open(os.path.join(edir, "events.jsonl"), "w") as f:
        f.write(json.dumps({"experiment_id": eid, "type": "TRAINING_FAILED",
                            "timestamp": 1, "reason": "boom"}) + "\n")
    st = build_state(str(tmp_path), _now())
    assert st["health"] == "FAILED"
    assert "boom" in (st["error"] or "")
