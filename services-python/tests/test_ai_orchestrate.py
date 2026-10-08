"""Orchestrator tests: states, duplicates, recovery, concurrency, governance.
Fast: fake launchers/backtests; one tiny synthetic dataset for the real
evaluation path. No long training, no subprocesses, no network.
"""

import json
import os

import pytest

from aurix_ai.orchestrate import (ExperimentRegistry, Scheduler, emit_event,
                                  experiment_id, pid_alive, read_heartbeat,
                                  runs_root, validate_definition)


def _def(ds, **over):
    d = {"dataset_dir": str(ds), "dataset_version": "ds-test",
         "model_type": "sgd-logloss",
         "hyperparameters": {"alpha": 0.0001, "random_state": 7},
         "seed": 7, "epochs": 2, "device": "cpu"}
    d.update(over)
    return d


def _seed_dataset(tmp):
    from aurix_ai.datasets import (DatasetSpec, build_features_labels,
                                   generate_ohlcv, write_dataset)
    bars = generate_ohlcv(7, 250, ("A",), 1700000000000)
    X, y, ts, inst = build_features_labels(bars, 5, 0.005)
    spec = DatasetSpec(dataset_id="t", version="v1", instruments=("A",),
                       n_bars=250, seed=7, horizon_bars=5, threshold=0.005,
                       start_ts=1700000000000)
    m = write_dataset(str(tmp / "ds"), spec, X, y, ts, inst)
    return str(tmp / "ds" / m["dataset_version"])


def _sched(root, **kw):
    kw.setdefault("launcher", lambda d, r, detach=False: None)
    return Scheduler(root, {"max_concurrent_training": 1, **kw.pop("policy", {})}, **kw)


def test_submit_and_duplicate_prevention(tmp_path):
    reg = ExperimentRegistry(str(tmp_path))
    rec = reg.submit(_def(str(tmp_path)))
    # dataset dir must exist: tmp_path exists, so submit works; duplicate refused
    assert rec["status"] == "QUEUED"
    with pytest.raises(Exception):
        reg.submit(_def(str(tmp_path)))
    assert os.path.isdir(os.path.join(str(tmp_path), rec["experiment_id"]))


def test_terminal_states_frozen(tmp_path):
    reg = ExperimentRegistry(str(tmp_path))
    rec = reg.submit(_def(str(tmp_path)))
    reg.transition(rec["experiment_id"], "REJECTED", "bad")
    with pytest.raises(Exception):
        reg.transition(rec["experiment_id"], "QUEUED", "reopen")


def test_missing_dataset_fails_closed(tmp_path):
    reg = ExperimentRegistry(str(tmp_path))
    with pytest.raises(Exception):
        reg.submit(_def("/nonexistent-ds"))  # fail-closed at submit: never queued
    assert reg.queued() == []


def test_start_once_and_concurrency_limit(tmp_path):
    calls = []
    reg_root = str(tmp_path)
    ds = _seed_dataset(tmp_path)
    s = _sched(reg_root, launcher=lambda d, r, detach=False: calls.append((d, r)))
    a = s.reg.submit(_def(ds, seed=7))
    b = s.reg.submit(_def(ds, seed=11))
    assert s.start_eligible() == [a["experiment_id"]] and len(calls) == 1
    assert s.start_eligible() == []  # second job blocked while one RUNNING
    assert len(calls) == 1
    assert s.reg.get(b["experiment_id"])["status"] == "QUEUED"


def test_stale_worker_resumes_from_checkpoint(tmp_path):
    reg_root = str(tmp_path)
    ds = _seed_dataset(tmp_path)
    s = _sched(reg_root)
    rec = s.reg.submit(_def(ds))
    eid = rec["experiment_id"]
    s.reg.transition(eid, "RUNNING", "test")
    edir = os.path.join(reg_root, eid)
    os.makedirs(os.path.join(edir, "checkpoints"))
    open(os.path.join(edir, "checkpoints", "checkpoint-0001.npz"), "w").write("x")
    with open(os.path.join(edir, "heartbeat.json"), "w") as f:
        json.dump({"pid": 99999999, "ts": 1, "epoch": 1,
                   "checkpoint": "checkpoint-0001.npz", "status": "running"}, f)
    calls = []
    s.launcher = lambda d, r, detach=False: calls.append((d, r))
    s.heartbeat_timeout_s = 1
    assert s.reap() == [(eid, "resumed")] and calls[0][1] is True


def test_dead_worker_without_checkpoint_restarts_cleanly(tmp_path):
    reg_root = str(tmp_path)
    ds = _seed_dataset(tmp_path)
    s = _sched(reg_root)
    rec = s.reg.submit(_def(ds))
    eid = rec["experiment_id"]
    s.reg.transition(eid, "RUNNING", "test")
    edir = os.path.join(reg_root, eid)
    with open(os.path.join(edir, "heartbeat.json"), "w") as f:
        json.dump({"pid": 99999999, "ts": 1, "epoch": 0,
                   "checkpoint": None, "status": "running"}, f)
    calls = []
    s.launcher = lambda d, r, detach=False: calls.append((d, r))
    s.heartbeat_timeout_s = 1
    assert s.reap() == [(eid, "restarted")] and calls[0][1] is False


def _with_artifact(s, eid, edir, ds):
    import joblib
    from aurix_ai.datasets import chrono_split, load_dataset
    from aurix_ai.model import MarketMLP
    X, y, _ts, _inst, _m = load_dataset(ds)
    tr, _va, te = chrono_split(len(y))
    m = MarketMLP()
    m.fit_scaler(X[tr])
    m.partial_epoch(X[tr], y[tr])
    os.makedirs(os.path.join(edir, "final"))
    joblib.dump({"coef": m.clf.coef_, "intercept": m.clf.intercept_,
                 "scaler_mean": m.scaler.mean_, "scaler_var": m.scaler.var_,
                 "alpha": m.alpha, "classes": m.classes_},
                os.path.join(edir, "final", "artifact.joblib"))
    return len(te)


def test_evaluation_transition_real_artifact(tmp_path):
    reg_root = str(tmp_path)
    ds = _seed_dataset(tmp_path)
    s = _sched(reg_root)
    rec = s.reg.submit(_def(ds))
    eid, edir = rec["experiment_id"], os.path.join(reg_root, rec["experiment_id"])
    s.reg.transition(eid, "COMPLETED", "test")
    n_te = _with_artifact(s, eid, edir, ds)
    assert s.evaluate_eligible() == [eid]
    ev = json.load(open(os.path.join(edir, "eval.json")))
    assert ev["n"] == n_te and s.reg.get(eid)["status"] == "EVALUATED"


def _governed(s, ds, acc, base, bt, with_bars=False):
    dd = _def(ds)
    if with_bars:
        bars = os.path.join(s.root, "bars.json")
        open(bars, "w").write("[]")
        dd["backtest_bars"] = bars
    rec = s.reg.submit(dd)
    eid, edir = rec["experiment_id"], os.path.join(s.root, rec["experiment_id"])
    s.reg.transition(eid, "EVALUATED", "test")
    with open(os.path.join(edir, "manifest.json"), "w") as f:
        json.dump({"artifact_sha256": "abc"}, f)
    with open(os.path.join(edir, "eval.json"), "w") as f:
        json.dump({"accuracy": acc, "baseline_majority_accuracy": base,
                   "precision": 0.5, "recall": 0.5, "n": 10}, f)
    s.backtest_runner = lambda b, e: bt
    s.govern_eligible({"min_oos_edge_vs_baseline": 0.01,
                       "max_backtest_drawdown_pct": 10.0})
    return eid, edir


def test_governance_blocks_weak_model(tmp_path):
    s = _sched(str(tmp_path))
    eid, edir = _governed(s, _seed_dataset(tmp_path), 0.48, 0.51,
                          {"ok": True, "max_drawdown_pct": 1.0})
    assert s.reg.get(eid)["status"] == "REJECTED"
    assert json.load(open(os.path.join(edir, "governance.json")))["outcome"] == "REJECTED"


def test_governance_validates_strong_model(tmp_path):
    s = _sched(str(tmp_path))
    eid, edir = _governed(s, _seed_dataset(tmp_path), 0.60, 0.51,
                          {"ok": True, "max_drawdown_pct": 1.0, "orders": 3},
                          with_bars=True)
    assert s.reg.get(eid)["status"] == "VALIDATED"
    from aurix_ai.registry import ModelRegistry
    mreg = ModelRegistry(os.path.join(s.root, "model-registry.json"))
    assert mreg.models[f"aurix-marketml-{eid}"]["state"] == "VALIDATED"


def test_governance_requires_backtest(tmp_path):
    # No backtest_bars in definition: even 90% accuracy cannot pass.
    s = _sched(str(tmp_path))
    eid, edir = _governed(s, _seed_dataset(tmp_path), 0.90, 0.51,
                          {"ok": True, "max_drawdown_pct": 0.0})
    assert s.reg.get(eid)["status"] == "REJECTED"


def test_runs_root_override_and_events(tmp_path):
    import aurix_ai.orchestrate as o
    assert o.runs_root(str(tmp_path)) == str(tmp_path)
    assert "data" in o.runs_root() and "runs" in o.runs_root()
    eid = "exp-test"
    os.makedirs(os.path.join(str(tmp_path), eid))
    row = emit_event(os.path.join(str(tmp_path), eid), eid, "EXPERIMENT_QUEUED", {})
    assert row["type"] == "EXPERIMENT_QUEUED" and row["code_version"]
    assert pid_alive(os.getpid()) is True
    assert pid_alive(99999999) is False
