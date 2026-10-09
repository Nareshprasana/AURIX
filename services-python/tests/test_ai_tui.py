"""TUI tests: command routing, pure rendering (progress/worker/failure/logs),
machine-readable state. No TTY needed; no training; temp only."""

import json
import os


def _state(**over):
    base = {"health": "RUNNING", "experiment_id": "exp-1", "dataset_id": "ds-v",
            "stage": "training", "worker_name": "training-worker", "worker_pid": 18432,
            "epoch": 2, "total_epochs": 4, "loss": 0.6842, "validation_loss": 0.7011,
            "progress": 0.5, "elapsed_seconds": 134, "heartbeat_age_seconds": 4,
            "checkpoint": "checkpoint-0002.npz",
            "last_event": {"timestamp": 1, "type": "checkpoint.saved"},
            "pipeline": [{"stage": n, "state": s} for n, s in
                         [("dataset", "PASSED"), ("training", "RUNNING"),
                          ("evaluation", "PENDING"), ("backtest", "PENDING"),
                          ("governance", "PENDING")]],
            "error": None}
    base.update(over)
    return base


def test_routing_registers_new_commands():
    from aurix_ai.cli import build_parser
    p = build_parser()
    for cmd in ("interactive", "auto-state", "auto-logs"):
        assert cmd in p._subparsers._group_actions[0].choices, cmd


def test_menu_render():
    from aurix_ai.tui import render_menu
    out = render_menu(_state(health="IDLE", experiment_id=None))
    assert "A U R I X" in out and "[1] Start training" in out and "[6] Exit" in out


def test_training_render_progress_and_worker():
    from aurix_ai.tui import render_training
    out = render_training(_state())
    assert "exp-1" in out and "18432" in out and "Epoch 2 / 4" in out
    assert "0.6842" in out and "0.7011" in out and "checkpoint-0002.npz" in out
    assert "50%" in out and "02:14" in out


def test_failure_render_with_diagnostics():
    from aurix_ai.tui import render_failure
    out = render_failure(_state(health="FAILED", stage="backtest", worker_pid=19104,
                                error="Backtest subprocess exited with code 1",
                                backtest_run={"stdout": "EMPTY", "stderr": "boom",
                                              "exit_code": 1},
                                checkpoint="checkpoint-0007.npz",
                                recovery_state="resumable from preserved checkpoint"))
    assert "TRAINING FAILED" in out and "BACKTEST" in out and "19104" in out
    assert "exit_code: 1" in out and "stderr:\nboom" in out
    assert "checkpoint-0007.npz" in out and "PRESERVED" in out and "RESUMABLE" in out


def test_failure_render_never_bare():
    from aurix_ai.tui import render_failure
    out = render_failure(_state(health="FAILED", error=None, backtest_run=None,
                                log_tail=["e1"], checkpoint=None,
                                recovery_state=None))
    assert "see events log" in out or "unknown" in out


def test_logs_render(tmp_path):
    from aurix_ai.tui import render_logs
    out = render_logs(_state(), [{"timestamp": 5, "type": "training.started"},
                                 {"timestamp": 6, "type": "boom", "error": "x"}])
    assert "training.started" in out and "boom" in out


def test_auto_state_machine_readable(tmp_path, capsys):
    from aurix_ai.cli import main
    from aurix_ai.orchestrate import ExperimentRegistry
    root = str(tmp_path)
    reg = ExperimentRegistry(root)
    ds = os.path.join(root, "ds")
    os.makedirs(ds)
    reg.submit({"dataset_dir": ds, "dataset_version": "ds-v", "model_type": "m",
                "hyperparameters": {}, "seed": 1, "epochs": 2, "device": "cpu"})
    assert main(["auto-state", "--runs", root]) == 0
    st = json.loads(capsys.readouterr().out)
    assert st["health"] == "STARTING" and st["stage"] == "dataset"


def test_auto_logs_command(tmp_path, capsys):
    from aurix_ai.cli import main
    from aurix_ai.orchestrate import ExperimentRegistry, emit_event
    root = str(tmp_path)
    reg = ExperimentRegistry(root)
    ds = os.path.join(root, "ds")
    os.makedirs(ds)
    rec = reg.submit({"dataset_dir": ds, "dataset_version": "ds-v", "model_type": "m",
                      "hyperparameters": {}, "seed": 1, "epochs": 2, "device": "cpu"})
    emit_event(os.path.join(root, rec["experiment_id"]), rec["experiment_id"],
               "training.started", {})
    assert main(["auto-logs", "--runs", root, "--last", "50"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert any(e["type"] == "training.started" for e in out["events"])


def test_aurix_cmd_covers_all_commands():
    import pathlib
    repo = pathlib.Path(__file__).resolve().parents[2]
    src = (repo / "aurix.cmd").read_text()
    assert "interactive" in src  # bare `aurix`
    assert "auto-status --concise" in src
    assert "auto-stop" in src
    assert "auto-train" in src
    assert "auto-logs" in src
