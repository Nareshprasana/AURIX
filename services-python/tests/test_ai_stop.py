"""Stop/status tests: idle behavior, graceful synthetic-worker stop,
checkpoint preservation, STOPPED recovery, hidden-process flags, protection.
Targeted only: temp roots, tiny synthetic data, no market training.
"""

import json
import os

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _tiny_dataset(tmp):
    from aurix_ai.datasets import (DatasetSpec, build_features_labels,
                                   generate_ohlcv, write_dataset)
    bars = generate_ohlcv(7, 220, ("A",), 1700000000000)
    X, y, ts, inst = build_features_labels(bars, 5, 0.005)
    spec = DatasetSpec(dataset_id="t", version="v1", instruments=("A",),
                       n_bars=220, seed=7, horizon_bars=5, threshold=0.005,
                       start_ts=1700000000000)
    m = write_dataset(os.path.join(str(tmp), "ds"), spec, X, y, ts, inst)
    return os.path.join(str(tmp), "ds", m["dataset_version"])


def _cli(*argv):
    from aurix_ai.cli import build_parser
    return build_parser().parse_args(list(argv))


def test_status_concise_idle(tmp_path, capsys):
    from aurix_ai.cli import main
    assert main(["auto-status", "--runs", str(tmp_path), "--concise"]) == 0
    out = capsys.readouterr().out
    assert "Training: IDLE" in out and "No active AURIX training job." in out


def test_stop_idle_reports_clearly(tmp_path, capsys):
    from aurix_ai.cli import main
    assert main(["auto-stop", "--runs", str(tmp_path), "--timeout", "5"]) == 0
    out = capsys.readouterr().out
    assert "No active AURIX training job." in out


def test_graceful_stop_of_synthetic_worker(tmp_path):
    import time
    from aurix_ai.cli import main
    from aurix_ai.orchestrate import (ExperimentRegistry, Scheduler,
                                      default_launcher, read_heartbeat)
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    reg = ExperimentRegistry(root)
    rec = reg.submit({"dataset_dir": ds, "dataset_version": "t",
                      "model_type": "sgd-logloss",
                      "hyperparameters": {"alpha": 0.0001, "random_state": 7},
                      "seed": 7, "epochs": 3, "device": "cpu"})
    eid, edir = rec["experiment_id"], os.path.join(root, rec["experiment_id"])
    s = Scheduler(root, {"max_concurrent_training": 1},
                  launcher=lambda d, r, detach=False: default_launcher(d, r, detach))
    assert s.start_eligible() == [eid]
    worker_pid = os.getpid()
    assert main(["auto-stop", "--runs", root, "--timeout", "90"]) == 0
    exp = ExperimentRegistry(root).get(eid)
    assert exp["status"] == "STOPPED"
    # Checkpoints preserved, run dir intact, event persisted.
    ckpts = sorted(f for f in os.listdir(os.path.join(edir, "checkpoints")))
    assert len(ckpts) >= 1
    events = open(os.path.join(edir, "events.jsonl")).read()
    assert "training.stopped" in events
    hb = read_heartbeat(edir)
    assert hb and hb.get("checkpoint") in ckpts
    # Worker was independent: someone else ran the training.
    assert hb.get("pid") != worker_pid
    # No new work started afterwards: second stop is a no-op for this exp.
    assert ExperimentRegistry(root).running() == []


def test_stopped_recovers_and_continues(tmp_path):
    from aurix_ai.orchestrate import ExperimentRegistry, Scheduler
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    s = Scheduler(root, {"max_concurrent_training": 1},
                  launcher=lambda d, r, detach=False: None)
    rec = s.reg.submit({"dataset_dir": ds, "dataset_version": "t",
                        "model_type": "sgd-logloss",
                        "hyperparameters": {"alpha": 0.0001, "random_state": 7},
                        "seed": 7, "epochs": 3, "device": "cpu"})
    eid, edir = rec["experiment_id"], os.path.join(root, rec["experiment_id"])
    # Simulate a stop that landed after the worker had finished everything.
    os.makedirs(os.path.join(edir, "checkpoints"))
    open(os.path.join(edir, "checkpoints", "checkpoint-0003.npz"), "w").write("x")
    with open(os.path.join(edir, "manifest.json"), "w") as f:
        json.dump({"status": "COMPLETED"}, f)
    with open(os.path.join(edir, "heartbeat.json"), "w") as f:
        json.dump({"pid": 1, "ts": 1, "epoch": 3,
                   "checkpoint": "checkpoint-0003.npz", "status": "done"}, f)
    s.reg.transition(eid, "STOPPED", "test stop")
    assert s.revive_stopped() == [(eid, "completed")]
    assert s.reg.get(eid)["status"] == "COMPLETED"
    assert s.revive_stopped() == []  # no duplicate revival


def test_hidden_process_flags(tmp_path):
    from unittest import mock
    import aurix_ai.cli as cli
    from aurix_ai import orchestrate as o
    seen = {}
    edir = os.path.join(str(tmp_path), "exp-x")
    os.makedirs(edir)

    class FakePopen:
        def __init__(self, *a, **k):
            seen.update(k)
            self.pid = 424242

    with mock.patch.object(o.subprocess, "Popen", FakePopen):
        o.default_launcher(edir, False, True)
    assert seen.get("creationflags", 0) & 0x08000000, "worker must set CREATE_NO_WINDOW"
    with mock.patch("subprocess.Popen", FakePopen):
        cli._spawn_supervisor(os.path.join(str(tmp_path), "sup"), 30)
    assert seen.get("creationflags", 0) & 0x08000000, "supervisor must set CREATE_NO_WINDOW"


def test_supervisor_start_refuses_duplicate(tmp_path):
    from unittest import mock
    import aurix_ai.cli as cli
    root = os.path.join(str(tmp_path), "runs")
    os.makedirs(root)
    with open(os.path.join(root, "supervisor.pid"), "w") as f:
        f.write(str(os.getpid()))  # a live pid: our own test process
    with mock.patch.object(cli, "_spawn_supervisor") as spawn:
        pid, fresh = cli._ensure_supervisor(root, 30)
    assert (pid, fresh) == (os.getpid(), False)
    spawn.assert_not_called()


def test_stop_never_kills_self(tmp_path, capsys):
    from aurix_ai.cli import main
    root = os.path.join(str(tmp_path), "runs")
    os.makedirs(root)
    with open(os.path.join(root, "supervisor.pid"), "w") as f:
        f.write(str(os.getpid()))
    assert main(["auto-stop", "--runs", root, "--timeout", "5"]) == 0
    assert os.getpid()  # still alive: self-kill refused


def test_stop_never_touches_foreign_dirs(tmp_path):
    from aurix_ai.cli import main
    root = os.path.join(str(tmp_path), "runs")
    os.makedirs(root)
    ghost = os.path.join(root, "exp-historical")
    os.makedirs(ghost)
    sentinel = os.path.join(ghost, "manifest.json")
    with open(sentinel, "w") as f:
        json.dump({"run_id": "real-nse-001"}, f)
    assert main(["auto-stop", "--runs", root, "--timeout", "5"]) == 0
    assert json.load(open(sentinel)) == {"run_id": "real-nse-001"}
    assert os.path.isdir(ghost)
