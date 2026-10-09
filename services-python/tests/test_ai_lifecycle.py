"""Lifecycle regression tests for the audit fixes. Temp roots only; tiny
synthetic fixtures; no market data, no network, no production writes."""

import json
import os

import pytest


def _tiny_dataset(tmp, bars=220, seed=7):
    from aurix_ai.datasets import (DatasetSpec, build_features_labels,
                                   generate_ohlcv, write_dataset)
    bars_d = generate_ohlcv(seed, bars, ("A",), 1700000000000)
    X, y, ts, inst = build_features_labels(bars_d, 5, 0.005)
    spec = DatasetSpec(dataset_id="t", version="v1", instruments=("A",),
                       n_bars=bars, seed=seed, horizon_bars=5, threshold=0.005,
                       start_ts=1700000000000)
    m = write_dataset(os.path.join(str(tmp), "ds"), spec, X, y, ts, inst)
    return os.path.join(str(tmp), "ds", m["dataset_version"])


def _submit(sched, ds, **over):
    d = {"dataset_dir": ds, "dataset_version": "t", "model_type": "sgd-logloss",
         "hyperparameters": {"alpha": 0.0001, "random_state": 7},
         "seed": 7, "epochs": 1, "device": "cpu"}
    d.update(over)
    return sched.reg.submit(d)


def test_supervised_revive_beats_duplicate_submit(tmp_path):
    from aurix_ai.orchestrate import ExperimentRegistry, Scheduler
    root = str(tmp_path)
    ds = _tiny_dataset(tmp_path)
    s = Scheduler(root, {"max_concurrent_training": 1},
                  launcher=lambda d, r, detach=False: None)
    rec = _submit(s, ds)
    eid, edir = rec["experiment_id"], os.path.join(root, rec["experiment_id"])
    s.reg.transition(eid, "RUNNING", "test")
    s.reg.transition(eid, "STOPPED", "user stop")
    with open(os.path.join(edir, "manifest.json"), "w") as f:
        json.dump({"status": "COMPLETED"}, f)
    with open(os.path.join(edir, "heartbeat.json"), "w") as f:
        json.dump({"pid": 1, "ts": 1, "epoch": 1,
                   "checkpoint": "checkpoint-0001.npz", "status": "done"}, f)
    # Supervised auto-train path must revive, never submit a duplicate.
    revived = s.revive_stopped(detach=False)
    assert revived == [(eid, "completed")]
    assert s.reg.get(eid)["status"] == "COMPLETED"
    with pytest.raises(Exception):
        s.reg.submit({**rec["definition"]})


def test_restart_budget_fails_after_three_strikes(tmp_path):
    from aurix_ai.orchestrate import Scheduler
    root = str(tmp_path)
    ds = _tiny_dataset(tmp_path)
    calls = []
    s = Scheduler(root, {"max_concurrent_training": 1, "heartbeat_timeout_s": 1},
                  launcher=lambda d, r, detach=False: calls.append(d))
    rec = _submit(s, ds)
    eid = rec["experiment_id"]
    s.reg.transition(eid, "RUNNING", "test")
    # Backdate start past the spawn grace period; heartbeat always stale/absent.
    rec2 = s.reg.get(eid)
    rec2["started_at"] = 1
    with open(os.path.join(root, eid, "experiment.json"), "w") as f:
        json.dump(rec2, f)
    for _ in range(3):
        assert s.reap() == [(eid, "restarted")]
    assert s.reap() == [(eid, "failed")]
    assert s.reg.get(eid)["status"] == "FAILED"
    assert len(calls) == 3  # no fourth blind restart


def test_backtest_infra_failure_is_failed_not_rejected(tmp_path):
    from aurix_ai.orchestrate import Scheduler
    root = str(tmp_path)
    ds = _tiny_dataset(tmp_path)

    def boom(bars, edir):
        raise RuntimeError("node exploded")

    s = Scheduler(root, {"max_concurrent_training": 1},
                  launcher=lambda d, r, detach=False: None,
                  backtest_runner=boom)
    rec = _submit(s, ds)
    eid, edir = rec["experiment_id"], os.path.join(root, rec["experiment_id"])
    s.reg.transition(eid, "EVALUATED", "test")
    with open(os.path.join(edir, "manifest.json"), "w") as f:
        json.dump({"artifact_sha256": "abc"}, f)
    with open(os.path.join(edir, "eval.json"), "w") as f:
        json.dump({"accuracy": 0.9, "baseline_majority_accuracy": 0.5,
                   "precision": 0.9, "recall": 0.9, "n": 10}, f)
    bars = os.path.join(root, "bars.json")
    open(bars, "w").write("[]")
    s.reg.exps[eid]["definition"]["backtest_bars"] = bars
    s.govern_eligible({"min_oos_edge_vs_baseline": 0.01,
                       "max_backtest_drawdown_pct": 10.0})
    assert s.reg.get(eid)["status"] == "FAILED"  # infra failure, not a verdict


def test_auto_retry_capped_and_rejected_refused(tmp_path, capsys):
    from aurix_ai.cli import main
    from aurix_ai.orchestrate import ExperimentRegistry
    root = str(tmp_path)
    ds = _tiny_dataset(tmp_path)
    reg = ExperimentRegistry(root)
    d = {"dataset_dir": ds, "dataset_version": "t", "model_type": "m",
         "hyperparameters": {}, "seed": 21, "epochs": 1, "device": "cpu"}
    rec = reg.submit(d)
    eid = rec["experiment_id"]
    reg.transition(eid, "RUNNING", "t")
    reg.transition(eid, "FAILED", "infra")
    assert main(["auto-retry", "--exp", eid, "--runs", root]) == 0
    # CLI runs its own registry instance: re-read from disk (no stale state).
    assert ExperimentRegistry(root).get(eid)["status"] == "QUEUED"
    out = json.loads(capsys.readouterr().out)
    assert out["attempt"] == 2
    rej = reg.submit({**d, "seed": 22})
    reg.transition(rej["experiment_id"], "RUNNING", "t")
    reg.transition(rej["experiment_id"], "REJECTED", "governance verdict")
    assert main(["auto-retry", "--exp", rej["experiment_id"], "--runs", root]) == 1


def test_supervisor_stale_lock_superseded(tmp_path):
    import time
    from unittest import mock
    import aurix_ai.cli as cli
    root = str(tmp_path)
    with open(os.path.join(root, "supervisor.pid"), "w") as f:
        f.write(str(os.getpid()))  # live pid, but heartbeat is ancient
    with open(os.path.join(root, "supervisor-heartbeat.json"), "w") as f:
        json.dump({"pid": os.getpid(), "ts": 1, "started_at": 1}, f)
    with mock.patch.object(cli, "_spawn_supervisor", return_value=777) as spawn:
        pid, fresh = cli._ensure_supervisor(root, 30)
    assert (pid, fresh) == (777, True)
    spawn.assert_called_once()


def test_supervisor_fresh_lock_reused(tmp_path):
    import time
    from unittest import mock
    import aurix_ai.cli as cli
    root = str(tmp_path)
    with open(os.path.join(root, "supervisor.pid"), "w") as f:
        f.write(str(os.getpid()))
    with open(os.path.join(root, "supervisor-heartbeat.json"), "w") as f:
        json.dump({"pid": os.getpid(), "ts": int(time.time() * 1000),
                   "started_at": 1}, f)
    with mock.patch.object(cli, "_spawn_supervisor") as spawn:
        pid, fresh = cli._ensure_supervisor(root, 30)
    assert (pid, fresh) == (os.getpid(), False)
    spawn.assert_not_called()


def test_split_worker_logs_and_trusted_heartbeat(tmp_path):
    from unittest import mock
    from aurix_ai import orchestrate as o
    edir = os.path.join(str(tmp_path), "exp-x")
    os.makedirs(edir)

    seen = {}

    class CapPopen:
        def __init__(self, *a, **k):
            seen.update(k)
            self.pid = 424242

    with mock.patch.object(o.subprocess, "Popen", CapPopen):
        o.default_launcher(edir, False, True)
    assert seen["stdout"].name.endswith("worker-stdout.log")
    assert seen["stderr"].name.endswith("worker-stderr.log")
    assert o.heartbeat_trusted({"pid": 99999999}) is False
    assert o.heartbeat_trusted({"pid": os.getpid()}) is True


def test_tui_start_failure_shows_notice_not_crash():
    from aurix_ai.tui import render_menu
    out = render_menu({"health": "IDLE", "last_outcome": None}, notice="start failed: boom")
    assert "! start failed: boom" in out and "[1] Start training" in out


def test_compact_end_to_end_submit_to_evaluated(tmp_path):
    """Tiny real worker through submit→RUNNING→COMPLETED→EVALUATED (temp only)."""
    import time
    from aurix_ai.orchestrate import Scheduler, default_launcher
    root = str(tmp_path)
    ds = _tiny_dataset(tmp_path)
    s = Scheduler(root, {"max_concurrent_training": 1, "heartbeat_timeout_s": 600},
                  launcher=lambda d, r, detach=False: default_launcher(d, r, detach))
    rec = _submit(s, ds)
    eid = rec["experiment_id"]
    assert s.start_eligible() == [eid]
    deadline = time.time() + 100
    while time.time() < deadline:
        s.reap()
        if s.reg.get(eid)["status"] == "COMPLETED":
            break
        time.sleep(2)
    assert s.reg.get(eid)["status"] == "COMPLETED"
    assert s.evaluate_eligible() == [eid]
    assert s.reg.get(eid)["status"] == "EVALUATED"
