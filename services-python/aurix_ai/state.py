"""Authoritative training state: the SINGLE source of truth consumed by the
terminal UI, `auto-status`/`auto-state`, and the future web frontend.

Nothing here trains, promotes, or deletes. It only READS persisted
supervisor/worker state (registry, heartbeats, metrics, events, manifests)
and derives health, stage, pipeline, progress, and diagnostics.
"""

from __future__ import annotations

import json
import os

CODE_VERSION = "0.1.0"

PIPELINE_STAGES = ("dataset", "training", "evaluation", "backtest", "governance", "registry")

STATE_FIELDS = ("state", "experiment_id", "dataset_id", "stage", "worker_name",
                "worker_pid", "epoch", "total_epochs", "loss", "validation_loss",
                "progress", "started_at", "updated_at", "elapsed_seconds",
                "heartbeat_age_seconds", "checkpoint", "last_event", "health",
                "error", "stdout_reference", "stderr_reference", "recovery_state")


def _read_json(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _tail_lines(path: str, n: int = 5) -> list:
    try:
        with open(path, errors="replace") as f:
            return f.read().splitlines()[-n:]
    except OSError:
        return []


def _tail_events(exp_dir: str, n: int = 20) -> list:
    path = os.path.join(exp_dir, "events.jsonl")
    try:
        with open(path) as f:
            rows = [json.loads(l) for l in f if l.strip()]
        return rows[-n:]
    except (OSError, ValueError):
        return []


def _metrics_tail(exp_dir: str):
    path = os.path.join(exp_dir, "metrics.jsonl")
    try:
        with open(path) as f:
            rows = [json.loads(l) for l in f if l.strip()]
        return rows[-1] if rows else None
    except (OSError, ValueError):
        return None


def pipeline_for(exp_dir: str, status: str) -> list:
    """Per-stage PENDING/RUNNING/PASSED/FAILED/BLOCKED derived from artifacts."""
    has_manifest = os.path.exists(os.path.join(exp_dir, "manifest.json"))
    has_eval = os.path.exists(os.path.join(exp_dir, "eval.json"))
    bt = _read_json(os.path.join(exp_dir, "backtest.json")) or {}
    gov = _read_json(os.path.join(exp_dir, "governance.json")) or {}
    failed = status in ("FAILED", "REJECTED")
    stages = []
    order = {"dataset": 0, "training": 1, "evaluation": 2, "backtest": 3,
             "governance": 4, "registry": 5}
    done = {"dataset": status != "QUEUED", "training": has_manifest, "evaluation": has_eval,
            "backtest": bool(bt), "governance": bool(gov),
            "registry": gov.get("outcome") == "VALIDATED"}
    current = {"QUEUED": "dataset", "RUNNING": "training", "STOPPED": "training",
               "COMPLETED": "evaluation", "EVALUATED": "backtest",
               "VALIDATED": "registry", "REJECTED": "governance",
               "FAILED": None, "CANCELLED": None, "PROMOTED": "registry"}.get(status)
    fail_stage = None
    if status == "REJECTED":
        fail_stage = "governance"
    elif status == "FAILED":
        fail_stage = "evaluation" if has_manifest and not has_eval else "training"
    for name in PIPELINE_STAGES:
        if fail_stage == name:
            st = "FAILED"
        elif done[name]:
            st = "PASSED"
        elif current is not None and order[name] < order[current]:
            st = "PASSED"
        elif current == name and not failed:
            st = "RUNNING"
        elif current is not None and order[name] > order[current]:
            st = "PENDING"
        else:
            st = "BLOCKED" if failed else "PENDING"
        stages.append({"stage": name, "state": st})
    _ = bt
    return stages


def build_state(runs_root: str, now_ms: int, stall_after_s: int = 600) -> dict:
    """Build the authoritative TrainingState. Never raises on missing data."""
    from .orchestrate import ExperimentRegistry, read_heartbeat
    reg = ExperimentRegistry(runs_root)
    exps = sorted(reg.exps.values(),
                  key=lambda e: (e.get("started_at") or e.get("created_at") or 0,
                                 e.get("created_at") or 0))
    live = [e for e in exps if e["status"] not in ("FAILED", "CANCELLED", "REJECTED",
                                                  "VALIDATED", "PROMOTED")]
    exp = live[-1] if live else (exps[-1] if exps else None)
    if exp is None:
        return {"state": "IDLE", "health": "IDLE", "experiment_id": None,
                "pipeline": [], "code_version": CODE_VERSION}
    eid = exp["experiment_id"]
    edir = os.path.join(runs_root, eid)
    hb = read_heartbeat(edir) or {}
    metrics = _metrics_tail(edir)
    events = _tail_events(edir)
    last_event = events[-1] if events else None
    gov = _read_json(os.path.join(edir, "governance.json")) or {}
    bt_run = _read_json(os.path.join(edir, "backtest-run.json")) or {}
    epoch = hb.get("epoch", (metrics or {}).get("epoch"))
    total = exp["definition"].get("epochs")
    hb_age = None
    if hb.get("ts"):
        hb_age = max(0, (now_ms - hb["ts"]) // 1000)
    started = exp.get("started_at") or exp.get("created_at")
    elapsed = max(0, (now_ms - started) // 1000) if started else None
    stop_pending = os.path.exists(os.path.join(runs_root, "stop.requested"))

    status = exp["status"]
    stage_by_status = {"QUEUED": "dataset", "RUNNING": "training",
                       "STOPPED": "training", "COMPLETED": "evaluation",
                       "EVALUATED": "backtest", "VALIDATED": "registry",
                       "REJECTED": "governance", "FAILED": "training",
                       "CANCELLED": "training", "PROMOTED": "registry",
                       "CHECKPOINTED": "training", "BACKTESTED": "governance"}
    health, worker, stage, error, recovery = status, None, stage_by_status.get(status, "training"), None, None
    if status == "QUEUED":
        health = "STARTING"
    elif status == "RUNNING":
        pid = hb.get("pid")
        worker = {"name": "training-worker", "pid": pid, "state": "RUNNING"}
        if hb.get("status") == "failed":
            health = "FAILED"
            error = f"worker failed: {hb.get('error', 'unknown')}"
            recovery = ("resumable from preserved checkpoint"
                        if hb.get("checkpoint") else "no checkpoint; safe to resubmit")
        elif hb.get("ts") is None:
            health = "STARTING"  # spawned, no heartbeat yet (grace period)
        elif hb_age is not None and hb_age > stall_after_s:
            health = "STALLED"
            error = (f"heartbeat stale for {hb_age}s "
                     f"(last epoch {epoch}, checkpoint {hb.get('checkpoint')})")
            recovery = "resumable from preserved checkpoint"
        else:
            health = "STOPPING" if stop_pending else "RUNNING"
    elif status == "STOPPED":
        health, recovery = "STOPPED", "resumable from preserved checkpoint"
        stage = "evaluation" if os.path.exists(os.path.join(edir, "manifest.json")) else "training"
    elif status == "COMPLETED":
        health, stage = "RUNNING", "evaluation"
    elif status == "EVALUATED":
        health, stage = "RUNNING", "backtest"
        worker = {"name": "backtest-worker", "pid": None,
                  "state": "RUNNING",
                  "note": "short-lived subprocess; see backtest-run.json"}
    elif status == "VALIDATED":
        health = "COMPLETED"
    elif status in ("REJECTED", "FAILED", "CANCELLED"):
        health = "FAILED" if status != "CANCELLED" else "STOPPED"
        error = _failure_reason(edir, events, gov, bt_run)
        recovery = ("resumable from preserved checkpoint"
                    if os.path.isdir(os.path.join(edir, "checkpoints")) and
                    bool(os.listdir(os.path.join(edir, "checkpoints")))
                    else "no checkpoint; safe to resubmit")
    progress = (epoch / total) if isinstance(epoch, (int, float)) and total else None
    log_path = os.path.join(edir, "worker.log")
    state = {
        "state": status, "experiment_id": eid,
        "dataset_id": exp.get("dataset_version") or exp["definition"].get("dataset_dir"),
        "stage": stage,
        "worker_name": (worker or {}).get("name"),
        "worker_pid": (worker or {}).get("pid"),
        "worker": worker,
        "epoch": epoch, "total_epochs": total,
        "loss": (metrics or {}).get("train_loss"),
        "validation_loss": (metrics or {}).get("val_loss"),
        "progress": progress,
        "started_at": started, "updated_at": (last_event or {}).get("timestamp"),
        "elapsed_seconds": elapsed, "heartbeat_age_seconds": hb_age,
        "checkpoint": hb.get("checkpoint"),
        "last_event": last_event, "health": health, "error": error,
        "stdout_reference": log_path, "stderr_reference": log_path,
        "log_tail": _tail_lines(log_path),
        "backtest_run": bt_run or None,
        "recovery_state": recovery,
        "pipeline": pipeline_for(edir, status),
        "code_version": CODE_VERSION,
    }
    assert all(k in state for k in STATE_FIELDS)
    return state


def _failure_reason(edir: str, events: list, gov: dict, bt_run: dict) -> str | None:
    for ev in reversed(events):
        if ev.get("type") in ("TRAINING_FAILED", "training.failed",
                              "GOVERNANCE_REJECTED"):
            reason = ev.get("reason") or ev.get("error")
            if reason:
                return f"{ev['type']}: {reason}"
    if gov.get("outcome") == "REJECTED":
        return (f"GOVERNANCE_REJECTED: edge={gov.get('edge')} "
                f"backtest_ok={gov.get('backtest_ok')}")
    if bt_run and not bt_run.get("ok"):
        return f"backtest failed: {bt_run.get('reason')}"
    return "failed (see events log)"


def is_stalled(state: dict, stall_after_s: int = 600) -> bool:
    return state.get("health") == "STALLED"


def detect_and_record_stall(runs_root: str, stall_after_s: int = 600) -> dict | None:
    """Emit one training.stalled event per newly-stalled experiment."""
    import time
    from .orchestrate import ExperimentRegistry, emit_event
    now_ms = int(time.time() * 1000)
    state = build_state(runs_root, now_ms, stall_after_s)
    if not is_stalled(state):
        return None
    eid = state["experiment_id"]
    edir = os.path.join(runs_root, eid)
    for ev in reversed(_tail_events(edir, 5)):
        if ev.get("type") == "training.stalled" and ev.get("epoch") == state.get("epoch"):
            return None  # already recorded for this epoch
    return emit_event(edir, eid, "training.stalled",
                      {"epoch": state.get("epoch"),
                       "heartbeat_age_seconds": state.get("heartbeat_age_seconds"),
                       "checkpoint": state.get("checkpoint")})
