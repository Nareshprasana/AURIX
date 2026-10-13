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
import tempfile
import time

from . import __version__ as CODE_VERSION
from .errors import fail

STATES = ("QUEUED", "RUNNING", "STOPPED", "CHECKPOINTED", "COMPLETED", "EVALUATED",
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


def protected_roots() -> list:
    """Production/local training roots. NEVER recursively deleted by any
    orchestrator, test, or verification cleanup (see SAFETY INCIDENT:
    data/runs/real-nse-001 loss). Cleanup is only ever allowed inside an
    isolated temporary test root created by the current test."""
    rr = repo_root()
    return [os.path.join(rr, "data", "runs"),
            os.path.join(rr, "data", "datasets"),
            os.path.join(rr, "data", "processed")]


def assert_safe_cleanup(path: str) -> str:
    """Guard for any recursive-delete helper: raises on protected roots or
    anything outside an isolated temporary directory."""
    from pathlib import Path
    p = Path(os.path.abspath(path)).resolve()
    tmp = Path(tempfile.gettempdir()).resolve()
    if p == tmp:
        raise fail("INVALID_CONFIG", f"refusing cleanup of temp root itself: {p}")
    for prot in protected_roots():
        rp = Path(os.path.abspath(prot)).resolve()
        if p == rp or rp in p.parents or p in rp.parents:
            raise fail("INVALID_CONFIG", f"refusing cleanup of protected root: {p}")
    if tmp not in p.parents:
        raise fail("INVALID_CONFIG", f"cleanup only allowed inside isolated temp dirs: {p}")
    return str(p)


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

    def requeue(self, eid: str, reason: str, max_retries: int = 3) -> dict:
        """Return a FAILED experiment to QUEUED for another attempt. History
        is appended, never rewritten; checkpoints/artifacts are preserved and
        reused. REJECTED (a valid governance verdict) can never be requeued.
        Raises when the retry budget is exhausted."""
        rec = self.exps.get(eid)
        if rec is None:
            raise fail("INVALID_CONFIG", f"unknown experiment: {eid}")
        if rec["status"] != "FAILED":
            raise fail("INVALID_CONFIG",
                       f"only FAILED experiments can be requeued (state={rec['status']})")
        attempts = sum(1 for h in rec.get("history", []) if h.get("to") == "QUEUED")
        if attempts >= max_retries:
            raise fail("INVALID_CONFIG", f"retry budget exhausted ({max_retries})")
        rec["status"] = "QUEUED"
        rec["completed_at"] = None
        rec["history"].append({"to": "QUEUED", "at": utc_ms(), "reason": reason})
        with open(os.path.join(self.root, eid, "experiment.json"), "w") as f:
            json.dump(rec, f, indent=2, sort_keys=True)
        self._save()
        return rec

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


def process_start_ms(pid: int) -> int | None:
    """Process creation time (ms since epoch) or None when unavailable.
    Used to defeat PID reuse: a heartbeat is only trusted when its recorded
    spawn time matches the live process. Windows-only; None elsewhere."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if os.name != "nt":
        return None
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-Process -Id {pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()"],
            capture_output=True, text=True, timeout=20)
        return int(r.stdout.strip().splitlines()[-1])
    except Exception:
        return None


def heartbeat_trusted(hb: dict | None, skew_ms: int = 120_000) -> bool:
    """A heartbeat is trusted only if its PID is alive AND (when both times
    are available) the live process started around when the worker recorded
    its own spawn. Defeats PID reuse without assuming PID identity."""
    if not hb:
        return False
    try:
        pid = int(hb.get("pid", -1))
    except (TypeError, ValueError):
        return False
    if not pid_alive(pid):
        return False
    spawned = hb.get("spawned_at")
    if spawned is None:
        return True
    started = process_start_ms(pid)
    if started is None:
        return True
    try:
        wmi_epoch_offset = 11644473600000
        return abs(int(started / 10000) - wmi_epoch_offset - int(spawned)) <= skew_ms
    except (TypeError, ValueError):
        return True


def latest_checkpoint(exp_dir: str) -> str | None:
    ckpts = sorted(glob.glob(os.path.join(exp_dir, "checkpoints", "*.npz")))
    return ckpts[-1] if ckpts else None


def windows_hidden_flags() -> int:
    """CREATE_NO_WINDOW so supervised/worker processes never open a visible
    console; combined with detach flags elsewhere for independence."""
    return 0x08000000 if os.name == "nt" else 0


def stop_requested(root: str) -> bool:
    return os.path.exists(os.path.join(root, "stop.requested"))


def request_stop(root: str) -> None:
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "stop.requested"), "w") as f:
        f.write(str(utc_ms()))


def clear_stop(root: str) -> None:
    try:
        os.remove(os.path.join(root, "stop.requested"))
    except OSError:
        pass


def default_launcher(exp_dir: str, resume: bool, detach: bool = False) -> subprocess.Popen:
    """Spawn the worker as an independent process (existing CLI, existing code).

    stdout and stderr are captured to SEPARATE persisted files so a failure
    with empty stdout still leaves stderr (and vice versa); both paths are
    reported in TrainingState. Never raises for a spawn failure — callers
    surface it; a failed spawn must be visible, not silent."""
    cmd = [sys.executable, "-m", "aurix_ai.cli", "auto-worker",
           "--exp-dir", exp_dir] + (["--resume"] if resume else [])
    svc_dir = os.path.join(repo_root(), "services-python")
    flags = 0
    if detach and os.name == "nt":
        flags = 0x00000008 | 0x00000200 | windows_hidden_flags()  # detached, own group, no window
    out = open(os.path.join(exp_dir, "worker-stdout.log"), "ab")
    try:
        err = open(os.path.join(exp_dir, "worker-stderr.log"), "ab")
    except OSError:
        out.close()
        raise
    return subprocess.Popen(cmd, cwd=svc_dir, stdout=out, stderr=err,
                            stdin=subprocess.DEVNULL,
                            start_new_session=(os.name != "nt"), creationflags=flags)


class Scheduler:
    def __init__(self, root: str, policy: dict, launcher=None, backtest_runner=None,
                 extended_runner=None):
        self.root = root
        self.policy = policy
        self.reg = ExperimentRegistry(root)
        self.launcher = launcher or default_launcher
        self.backtest_runner = backtest_runner or (lambda bars, exp_dir: {"ok": False, "reason": "no-runner"})
        self.extended_runner = extended_runner or (lambda bars, exp_dir, mode: {"ok": False, "reason": "no-runner"})
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

    def _recovery_allowed(self, edir: str, hb: dict | None) -> bool:
        """Cap blind restarts: at most 3 recovery launches without epoch
        progress, then FAIL with diagnostics instead of looping forever.
        Progress resets the budget. State lives in the exp dir (survives
        scheduler restarts); checkpoints are never touched."""
        path = os.path.join(edir, "recovery.json")
        try:
            rec = json.load(open(path)) if os.path.exists(path) else {}
        except (OSError, ValueError):
            rec = {}
        epoch = (hb or {}).get("epoch", 0) or 0
        if epoch != rec.get("last_epoch", -1):
            rec = {"attempts": 0, "last_epoch": epoch}
        if rec.get("attempts", 0) >= 3:
            return False
        rec["attempts"] = rec.get("attempts", 0) + 1
        try:
            with open(path, "w") as f:
                json.dump(rec, f)
        except OSError:
            return False
        return True

    # -- stage 2: reap / recover -------------------------------------------
    def reap(self, detach: bool = False) -> list:
        acted = []
        for exp in self.reg.running():
            eid = exp["experiment_id"]
            edir = self._exp_dir(eid)
            hb = read_heartbeat(edir)
            if hb is not None and hb.get("status") == "failed":
                self.reg.transition(eid, "FAILED",
                                    f"worker failed: {hb.get('error', 'unknown')}")
                emit_event(edir, eid, "training.failed",
                           {"error": hb.get("error"), "epoch": hb.get("epoch"),
                            "checkpoint": hb.get("checkpoint")})
                acted.append((eid, "failed"))
                continue
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
                try:
                    os.remove(os.path.join(edir, "recovery.json"))
                except OSError:
                    pass
                acted.append((eid, "completed"))
                continue
            stale = (hb is None or (utc_ms() - hb.get("ts", 0)) > self.heartbeat_timeout_s * 1000)
            dead = (hb is None) or not heartbeat_trusted(hb)
            if stale or dead:
                if not self._recovery_allowed(edir, hb):
                    self.reg.transition(eid, "FAILED",
                                        "worker failed to progress after repeated recovery attempts")
                    emit_event(edir, eid, "training.failed",
                               {"reason": "recovery budget exhausted",
                                "epoch": (hb or {}).get("epoch"),
                                "checkpoint": (hb or {}).get("checkpoint")})
                    acted.append((eid, "failed"))
                    continue
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
    def _extended_gate(self, eid: str, edir: str, bars_path: str, kind: str,
                       cfg: dict, decision: dict) -> bool:
        """Run one extended gate (walkforward|stress). Returns pass/fail.
        Infra errors raise BACKTEST_FAILED (retryable FAILED); poor results
        return False (governance REJECTED). Results persisted + audited."""
        if not os.path.exists(bars_path):
            raise fail("BACKTEST_FAILED",
                       f"{kind} bars missing at gate time: {bars_path}")
        if kind == "walkforward":
            spec = (f"{int(cfg.get('train_bars', 60))},{int(cfg.get('test_bars', 20))},"
                    f"{int(cfg.get('step_bars', 20))},{int(cfg.get('max_windows', 4))}")
            mode = f"walkforward={spec}"
            fname, evname = "walkforward.json", "WALKFORWARD_COMPLETED"
        else:
            mode = "stress"
            fname, evname = "stress.json", "STRESS_COMPLETED"
        emit_event(edir, eid, f"{kind.upper()}_STARTED", {"bars": bars_path})
        try:
            res = self.extended_runner(bars_path, edir, mode)
        except Exception as e:
            res = {"ok": False, "infra_error": True, "reason": f"runner error: {e}"}
        with open(os.path.join(edir, fname), "w") as f:
            json.dump(res, f, indent=2, sort_keys=True, default=str)
        if res.get("infra_error"):
            raise fail("BACKTEST_FAILED",
                       f"{kind} infrastructure failure: {res.get('reason')}")
        emit_event(edir, eid, evname, {"ok": bool(res.get("ok"))})
        decision[kind] = res
        if not res.get("ok"):
            return False
        if kind == "walkforward":
            floor = float(cfg.get("min_median_sharpe", 0.0))
            try:
                med = float(res.get("median_test_sharpe"))
                n_windows = int(res.get("windows", 0))
            except (TypeError, ValueError):
                raise fail("BACKTEST_FAILED",
                           f"{kind} result malformed (median/windows unparsable)")
            if n_windows < 1:
                # Non-vacuity fail-closed: zero evaluated windows cannot
                # support a verdict. This is NOT a statistical sample-size
                # claim: the minimum-windows threshold for a meaningful
                # median Sharpe is UNSPECIFIED in approved policy (U8
                # blocker) — no value is invented here.
                return False
            if med < floor:
                return False
        else:
            cap = float(cfg.get("max_stressed_dd_pct", 10.0))
            try:
                worst = float(res.get("max_stressed_dd"))
            except (TypeError, ValueError):
                raise fail("BACKTEST_FAILED",
                           f"{kind} result malformed (max_stressed_dd unparsable)")
            if worst > cap:
                return False
        return True

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
                bt = {"ok": False, "infra_error": True,
                      "reason": f"runner error: {e}"}
        else:
            bt = {"ok": False, "reason": "no backtest bars provided; gate missing"}
        with open(os.path.join(edir, "backtest.json"), "w") as f:
            json.dump(bt, f, indent=2, sort_keys=True)
        emit_event(edir, eid, "BACKTEST_COMPLETED", {"ok": bool(bt.get("ok"))})
        max_dd = float(gates.get("max_backtest_drawdown_pct", 10.0))
        if bt.get("infra_error"):
            # The gate itself broke (crash/empty output) — that is an
            # infrastructure failure, NOT a governance rejection. Fail so it
            # stays retryable; never launder it into a model verdict.
            raise fail("BACKTEST_FAILED",
                       f"backtest infrastructure failure: {bt.get('reason')}")
        bt_ok = bool(bt.get("ok")) and float(bt.get("max_drawdown_pct", 100.0)) <= max_dd
        wf_cfg = gates.get("walkforward") or {}
        st_cfg = gates.get("stress") or {}
        decision = {"edge": edge, "min_edge": min_edge, "backtest_ok": bt_ok,
                    "backtest": bt,
                    "policy_version": str(gates.get("policy_version", "unknown")),
                    "gates": {"min_oos_edge_vs_baseline": min_edge,
                              "max_backtest_drawdown_pct": max_dd,
                              "walkforward": dict(wf_cfg), "stress": dict(st_cfg)}}
        # Extended gates: walk-forward + stress. Only evaluated when the base
        # gate passes (saves compute); absent/disabled sections mean "not
        # required" so older callers and tests keep prior behavior.
        wf_ok, st_ok = True, True
        if bt_ok and bars_path and os.path.exists(bars_path):
            if wf_cfg.get("enabled", False):
                wf_ok = self._extended_gate(eid, edir, bars_path, "walkforward",
                                            wf_cfg, decision)
            if wf_ok and st_cfg.get("enabled", False):
                st_ok = self._extended_gate(eid, edir, bars_path, "stress",
                                            st_cfg, decision)
        mreg = ModelRegistry(os.path.join(self.root, "model-registry.json"))
        model_id = f"aurix-marketml-{eid}"
        if edge >= min_edge and bt_ok and wf_ok and st_ok:
            if model_id not in mreg.models:
                art_sha = json.load(open(os.path.join(edir, "manifest.json")))["artifact_sha256"]
                mreg.register(model_id, eid, art_sha, "orchestrator")
            mreg.promote(model_id, "VALIDATED", "orchestrator",
                         f"oos edge {edge:.4f} >= {min_edge}; backtest+wf+stress ok")
            self.reg.transition(eid, "VALIDATED", f"edge={edge:.4f} backtest+wf+stress ok")
            emit_event(edir, eid, "MODEL_VALIDATED", decision)
            decision["outcome"] = "VALIDATED"
        else:
            self.reg.transition(eid, "REJECTED",
                                f"edge={edge:.4f} (min {min_edge}) backtest_ok={bt_ok} "
                                f"wf_ok={wf_ok} stress_ok={st_ok}")
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
        if stop_requested(self.root):
            return {"started": [], "reaped": [], "evaluated": [], "governed": [],
                    "stalled": None, "stopped": True}
        from .state import detect_and_record_stall
        out = {"started": self.start_eligible(detach=detach),
               "reaped": self.reap(detach=detach),
               "evaluated": self.evaluate_eligible(),
               "governed": self.govern_eligible(gates or {}),
               "stalled": detect_and_record_stall(self.root)}
        return out

    def revive_stopped(self, detach: bool = False) -> list:
        """Explicit user restart (`aurix train`): STOPPED exps resume safely.
        Manifest-complete ones rejoin the lifecycle; others relaunch workers
        from their preserved checkpoints. Never duplicates, never overwrites."""
        revived = []
        for exp in list(self.reg.exps.values()):
            if exp["status"] != "STOPPED":
                continue
            if len(self.reg.running()) >= self.max_concurrent:
                break
            eid = exp["experiment_id"]
            edir = self._exp_dir(eid)
            hb = read_heartbeat(edir)
            manifest_done = os.path.exists(os.path.join(edir, "manifest.json"))
            if manifest_done and hb and hb.get("status") == "done":
                self.reg.transition(eid, "COMPLETED", "revived after stop; work was complete")
                emit_event(edir, eid, "TRAINING_COMPLETED",
                           {"epochs": hb.get("epoch", 0), "note": "completed before stop"})
                revived.append((eid, "completed"))
            else:
                self.reg.transition(eid, "RUNNING", "revived after stop; resuming from checkpoint")
                emit_event(edir, eid, "TRAINING_RESUMED",
                           {"from": (hb or {}).get("checkpoint"), "reason": "user restart"})
                self.launcher(edir, True, detach)
                revived.append((eid, "resumed"))
        return revived
