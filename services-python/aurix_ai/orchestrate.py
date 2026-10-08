"""AURIX Training & Experiment Orchestrator (local-first, single heavy job).

Lifecycle: QUEUED -> RUNNING -> (CHECKPOINTED) -> COMPLETED -> EVALUATED ->
BACKTESTED -> VALIDATED | REJECTED (FAILED/CANCELLED terminal otherwise).

- Reuses run_training(), checkpoints, evaluate_proba, ModelRegistry, resources.
- Workers are independent processes writing ONLY their own data/runs/<id>/ dir.
- Scheduler state survives restarts (registry.json + per-exp experiment.json).
- Default: max 1 concurrent heavy job. No Docker, no services, no new infra.
- Never promotes on accuracy alone; backtest gate + deterministic governance.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import subprocess
import sys
import time

from . import __version__ as CODE_VERSION
from .errors import fail

STATES = ("QUEUED", "RUNNING", "CHECKPOINTED", "COMPLETED", "EVALUATED",
          "BACKTESTED", "FAILED", "CANCELLED", "REJECTED", "VALIDATED", "PROMOTED")
TERMINAL = ("FAILED", "CANCELLED", "REJECTED", "VALIDATED", "PROMOTED")

REQUIRED_DEF_FIELDS = ("dataset_dir", "model_type", "hyperparameters", "seed", "epochs")


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def runs_root(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("AURIX_RUNS_DIR")
    if env:
        return env
    return os.path.join(repo_root(), "data", "runs")


def utc_ms() -> int:
    return int(time.time() * 1000)


def experiment_id(defn: dict) -> str:
    h = hashlib.sha256(json.dumps({
        "dataset": defn.get("dataset_version") or defn.get("dataset_dir"),
        "model": defn.get("model_type"), "hp": defn.get("hyperparameters"),
        "seed": defn.get("seed"), "epochs": defn.get("epochs")},
        sort_keys=True).encode()).hexdigest()[:10]
    return f"exp-{h}"


def validate_definition(defn: dict) -> dict:
    missing = [k for k in REQUIRED_DEF_FIELDS if defn.get(k) is None]
    if missing:
        raise fail("INVALID_CONFIG", f"experiment missing fields: {missing}")
    if not isinstance(defn["epochs"], int) or defn["epochs"] < 1:
        raise fail("INVALID_CONFIG", "epochs must be a positive int")
    if not os.path.isdir(defn["dataset_dir"]):
        raise fail("DATASET_MISSING", f"dataset dir absent: {defn['dataset_dir']}")
    return dict(defn)


class ExperimentRegistry:
    """File-backed registry. Metadata immutable; status moves via history."""

    def __init__(self, root: str):
        self.root = root
        self.path = os.path.join(root, "registry.json")
        os.makedirs(root, exist_ok=True)
        self._load()

    def _load(self):
        if os.path.exists(self.path):
            with open(self.path) as f:
                self.exps = json.load(f)
        else:
            self.exps = {}

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.exps, f, indent=2, sort_keys=True)
        os.replace(tmp, self.path)

    def submit(self, defn: dict) -> dict:
        clean = validate_definition(defn)
        eid = experiment_id(clean)
        if eid in self.exps:
            raise fail("INVALID_CONFIG", f"experiment exists (immutable): {eid}")
        exp_dir = os.path.join(self.root, eid)
        if os.path.exists(exp_dir):
            raise fail("INVALID_CONFIG", f"run directory exists (refusing reuse): {eid}")
        os.makedirs(exp_dir)
        rec = {"experiment_id": eid, "status": "QUEUED", "definition": clean,
               "dataset_version": clean.get("dataset_version"),
               "created_at": utc_ms(), "started_at": None, "completed_at": None,
               "history": [{"to": "QUEUED", "at": utc_ms(), "reason": "submitted"}]}
        with open(os.path.join(exp_dir, "experiment.json"), "w") as f:
            json.dump(rec, f, indent=2, sort_keys=True)
        self.exps[eid] = rec
        self._save()
        return rec

    def transition(self, eid: str, to: str, reason: str) -> dict:
        rec = self.exps.get(eid)
        if rec is None:
            raise fail("INVALID_CONFIG", f"unknown experiment: {eid}")
        if rec["status"] in TERMINAL:
            raise fail("INVALID_CONFIG", f"{eid} is terminal ({rec['status']})")
        rec["status"] = to
        if to == "RUNNING" and rec["started_at"] is None:
            rec["started_at"] = utc_ms()
        if to in TERMINAL:
            rec["completed_at"] = utc_ms()
        rec["history"].append({"to": to, "at": utc_ms(), "reason": reason})
        with open(os.path.join(self.root, eid, "experiment.json"), "w") as f:
            json.dump(rec, f, indent=2, sort_keys=True)
        self._save()
        return rec

    def get(self, eid: str) -> dict | None:
        return self.exps.get(eid)

    def running(self) -> list:
        return [e for e in self.exps.values() if e["status"] == "RUNNING"]

    def queued(self) -> list:
        return sorted([e for e in self.exps.values() if e["status"] == "QUEUED"],
                      key=lambda e: e["created_at"])


def emit_event(exp_dir: str, exp_id: str, etype: str, extra: dict | None = None,
               worker: int | None = None) -> dict:
    row = {"experiment_id": exp_id, "type": etype, "timestamp": utc_ms(),
           "worker": worker if worker is not None else os.getpid(),
           "code_version": CODE_VERSION}
    if extra:
        row.update(extra)
    with open(os.path.join(exp_dir, "events.jsonl"), "a") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")
    return row


def read_heartbeat(exp_dir: str) -> dict | None:
    path = os.path.join(exp_dir, "heartbeat.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def pid_alive(pid: int) -> bool:
    """Best-effort liveness probe. Never uses POSIX signals on Windows
    (os.kill destabilizes teardown there); tasklist instead. Heartbeat
    staleness remains the primary death signal either way."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if os.name == "nt":
        try:
            r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                               capture_output=True, text=True, timeout=15)
            return str(pid) in r.stdout
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def latest_checkpoint(exp_dir: str) -> str | None:
    ckpts = sorted(glob.glob(os.path.join(exp_dir, "checkpoints", "*.npz")))
    return ckpts[-1] if ckpts else None


def default_launcher(exp_dir: str, resume: bool, detach: bool = False) -> subprocess.Popen:
    """Spawn the worker as an independent process (existing CLI, existing code)."""
    cmd = [sys.executable, "-m", "aurix_ai.cli", "auto-worker",
           "--exp-dir", exp_dir] + (["--resume"] if resume else [])
    svc_dir = os.path.join(repo_root(), "services-python")
    flags = 0
    if detach and os.name == "nt":
        flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(cmd, cwd=svc_dir, stdout=open(os.path.join(exp_dir, "worker.log"), "ab"),
                            stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            start_new_session=(os.name != "nt"), creationflags=flags)


class Scheduler:
    def __init__(self, root: str, policy: dict, launcher=None, backtest_runner=None):
        self.root = root
        self.policy = policy
        self.reg = ExperimentRegistry(root)
        self.launcher = launcher or default_launcher
        self.backtest_runner = backtest_runner or (lambda bars, exp_dir: {"ok": False, "reason": "no-runner"})
        self.heartbeat_timeout_s = int(policy.get("heartbeat_timeout_s", 600))
        self.max_concurrent = int(policy.get("max_concurrent_training", 1))

    def _exp_dir(self, eid: str) -> str:
        return os.path.join(self.root, eid)

    # -- stage 1: start eligible work --------------------------------------
    def start_eligible(self, detach: bool = False) -> list:
        started = []
        for exp in self.reg.queued():
            if len(self.reg.running()) >= self.max_concurrent:
                break
            eid = exp["experiment_id"]
            try:
                from .datasets import load_dataset
                load_dataset(exp["definition"]["dataset_dir"])
            except Exception as e:
                self.reg.transition(eid, "FAILED", f"dataset validation failed: {e}")
                emit_event(self._exp_dir(eid), eid, "TRAINING_FAILED",
                           {"reason": "dataset", "error": str(e)})
                continue
            self.reg.transition(eid, "RUNNING", "worker spawned")
            emit_event(self._exp_dir(eid), eid, "TRAINING_STARTED",
                       {"dataset_version": exp.get("dataset_version")})
            self.launcher(self._exp_dir(eid), False, detach)
            started.append(eid)
        return started

    # -- stage 2: reap / recover -------------------------------------------
    def reap(self, detach: bool = False) -> list:
        acted = []
        for exp in self.reg.running():
            eid = exp["experiment_id"]
            edir = self._exp_dir(eid)
            hb = read_heartbeat(edir)
            # Grace period: a freshly spawned worker needs time for its first
            # heartbeat. Reaping too early would spawn a DUPLICATE worker.
            age_s = (utc_ms() - (exp.get("started_at") or utc_ms())) / 1000
            if hb is None and age_s < 120:
                continue
            manifest_done = os.path.exists(os.path.join(edir, "manifest.json"))
            if manifest_done and hb and hb.get("status") == "done":
                self.reg.transition(eid, "COMPLETED", "worker reported done")
                emit_event(edir, eid, "TRAINING_COMPLETED",
                           {"epochs": hb.get("epoch", 0)})
                acted.append((eid, "completed"))
                continue
            stale = (hb is None or (utc_ms() - hb.get("ts", 0)) > self.heartbeat_timeout_s * 1000)
            dead = (hb is not None and not pid_alive(int(hb.get("pid", -1))))
            if stale or dead:
                ckpt = latest_checkpoint(edir)
                if ckpt:
                    emit_event(edir, eid, "TRAINING_RESUMED",
                               {"from": os.path.basename(ckpt),
                                "reason": "stale-heartbeat" if stale else "dead-worker"})
                    self.launcher(edir, True, detach)
                    acted.append((eid, "resumed"))
                else:
                    emit_event(edir, eid, "TRAINING_FAILED",
                               {"reason": "worker lost before first checkpoint; restarting from epoch 0"})
                    self.launcher(edir, False, detach)
                    acted.append((eid, "restarted"))
        return acted

    # -- stage 3: evaluate ---------------------------------------------------
    def evaluate(self, eid: str) -> dict:
        from .datasets import chrono_split, load_dataset
        from .train import evaluate_proba
        import joblib
        import numpy as np
        exp = self.reg.get(eid)
        edir = self._exp_dir(eid)
        emit_event(edir, eid, "EVALUATION_STARTED", {})
        X, y, _ts, _inst, _ds = load_dataset(exp["definition"]["dataset_dir"])
        art = joblib.load(os.path.join(edir, "final", "artifact.joblib"))
        scale = np.sqrt(np.maximum(art["scaler_var"], 1e-12))
        proba = 1.0 / (1.0 + np.exp(-((X - art["scaler_mean"]) / scale @ art["coef"].T
                                        + art["intercept"]).ravel()))
        _tr, _va, te = chrono_split(len(y))
        ev = evaluate_proba(y[te], proba[te])
        with open(os.path.join(edir, "eval.json"), "w") as f:
            json.dump(ev, f, indent=2, sort_keys=True)
        self.reg.transition(eid, "EVALUATED", f"oos acc={ev['accuracy']:.4f} n={ev['n']}")
        emit_event(edir, eid, "EVALUATION_COMPLETED", ev)
        return ev

    def evaluate_eligible(self) -> list:
        done = []
        for eid, exp in list(self.reg.exps.items()):
            if exp["status"] == "COMPLETED":
                try:
                    self.evaluate(eid)
                    done.append(eid)
                except Exception as e:
                    self.reg.transition(eid, "FAILED", f"evaluation failed: {e}")
                    emit_event(self._exp_dir(eid), eid, "TRAINING_FAILED",
                               {"reason": "evaluation", "error": str(e)})
        return done

    # -- stage 4: backtest gate + governance --------------------------------
    def govern(self, eid: str, gates: dict) -> dict:
        from .registry import ModelRegistry
        exp = self.reg.get(eid)
        edir = self._exp_dir(eid)
        ev = json.load(open(os.path.join(edir, "eval.json")))
        edge = ev["accuracy"] - ev["baseline_majority_accuracy"]
        min_edge = float(gates.get("min_oos_edge_vs_baseline", 0.01))
        bt = None
        bars_path = exp["definition"].get("backtest_bars")
        emit_event(edir, eid, "BACKTEST_STARTED", {"bars": bars_path})
        if bars_path and os.path.exists(bars_path):
            try:
                bt = self.backtest_runner(bars_path, edir)
            except Exception as e:
                bt = {"ok": False, "reason": f"runner error: {e}"}
        else:
            bt = {"ok": False, "reason": "no backtest bars provided; gate missing"}
        with open(os.path.join(edir, "backtest.json"), "w") as f:
            json.dump(bt, f, indent=2, sort_keys=True)
        emit_event(edir, eid, "BACKTEST_COMPLETED", {"ok": bool(bt.get("ok"))})
        max_dd = float(gates.get("max_backtest_drawdown_pct", 10.0))
        bt_ok = bool(bt.get("ok")) and float(bt.get("max_drawdown_pct", 100.0)) <= max_dd
        decision = {"edge": edge, "min_edge": min_edge, "backtest_ok": bt_ok,
                    "backtest": bt}
        mreg = ModelRegistry(os.path.join(self.root, "model-registry.json"))
        model_id = f"aurix-marketml-{eid}"
        if edge >= min_edge and bt_ok:
            if model_id not in mreg.models:
                art_sha = json.load(open(os.path.join(edir, "manifest.json")))["artifact_sha256"]
                mreg.register(model_id, eid, art_sha, "orchestrator")
            mreg.promote(model_id, "VALIDATED", "orchestrator",
                         f"oos edge {edge:.4f} >= {min_edge}; backtest ok")
            self.reg.transition(eid, "VALIDATED", f"edge={edge:.4f} backtest ok")
            emit_event(edir, eid, "MODEL_VALIDATED", decision)
            decision["outcome"] = "VALIDATED"
        else:
            self.reg.transition(eid, "REJECTED",
                                f"edge={edge:.4f} (min {min_edge}) backtest_ok={bt_ok}")
            emit_event(edir, eid, "GOVERNANCE_REJECTED", decision)
            decision["outcome"] = "REJECTED"
        with open(os.path.join(edir, "governance.json"), "w") as f:
            json.dump(decision, f, indent=2, sort_keys=True)
        with open(os.path.join(edir, "knowledge_refs.jsonl"), "a") as f:
            f.write(json.dumps({"assertion": "OBSERVATION", "kind": "experiment-result",
                                "refs": {"experiment_id": eid, "outcome": decision["outcome"],
                                         "edge": edge}}) + "\n")
        return decision

    def govern_eligible(self, gates: dict) -> list:
        done = []
        for eid, exp in list(self.reg.exps.items()):
            if exp["status"] == "EVALUATED":
                try:
                    self.govern(eid, gates)
                    done.append(eid)
                except Exception as e:
                    self.reg.transition(eid, "FAILED", f"governance failed: {e}")
        return done

    def cycle(self, detach: bool = False, gates: dict | None = None) -> dict:
        out = {"started": self.start_eligible(detach=detach),
               "reaped": self.reap(detach=detach),
               "evaluated": self.evaluate_eligible(),
               "governed": self.govern_eligible(gates or {})}
        return out
