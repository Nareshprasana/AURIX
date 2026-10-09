"""Safety + root-command tests for `aurix train`.

- Cleanup can never touch production training roots (SAFETY INCIDENT guard).
- `aurix train` needs no args, returns fast, workers stay independent.
- Existing run dirs are immutable historical state.
Targeted only: no long training, no network, temp roots exclusively.
"""

import json
import os

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_cleanup_guard_protects_production_roots():
    from aurix_ai.orchestrate import assert_safe_cleanup, protected_roots
    assert len(protected_roots()) == 3
    for prot in protected_roots():
        with pytest.raises(Exception):
            assert_safe_cleanup(prot)
    with pytest.raises(Exception):
        assert_safe_cleanup(REPO)  # ancestor of protected roots
    import tempfile
    with pytest.raises(Exception):
        assert_safe_cleanup(tempfile.gettempdir())  # temp root itself


def test_cleanup_guard_allows_isolated_temp(tmp_path):
    from aurix_ai.orchestrate import assert_safe_cleanup
    mine = os.path.join(str(tmp_path), "my-run")
    os.makedirs(mine)
    assert assert_safe_cleanup(mine) == mine


def test_no_recursive_delete_of_data_roots_in_code():
    import aurix_ai
    root = os.path.dirname(aurix_ai.__file__)
    hits = []
    for fn in sorted(os.listdir(root)):
        if not fn.endswith(".py"):
            continue
        src = open(os.path.join(root, fn), encoding="utf-8").read()
        # shutil.which (CLI lookup) is read-only and allowed; anything that
        # deletes/moves trees is forbidden.
        for pat in ("shutil.rmtree", "shutil.move", "shutil.copytree"):
            if pat in src:
                hits.append(f"{fn}::{pat}")
    assert hits == []
    for mod in ("orchestrate.py", "worker.py"):
        src = open(os.path.join(root, mod), encoding="utf-8").read()
        # Narrow exception: scheduler-owned control flags only (stop marker,
        # recovery budget). Never datasets, runs, checkpoints, or artifacts.
        for i, line in enumerate(src.split("\n")):
            if "os.remove(" in line:
                assert ("stop.requested" in line or "recovery.json" in line), f"{mod}:{i + 1}"
        assert "unlink(" not in src, mod
        assert "rmtree" not in src, mod
    scripts = os.path.join(REPO, "scripts")
    for fn in sorted(os.listdir(scripts)):
        if not fn.endswith(".mjs"):
            continue
        src = open(os.path.join(scripts, fn)).read()
        assert "Remove-Item -Recurse" not in src, fn


def test_existing_run_dir_is_immutable(tmp_path):
    from aurix_ai.orchestrate import ExperimentRegistry, Scheduler
    root = str(tmp_path)
    ghost = os.path.join(root, "exp-historical")
    os.makedirs(ghost)
    sentinel = os.path.join(ghost, "manifest.json")
    with open(sentinel, "w") as f:
        json.dump({"run_id": "real-nse-001"}, f)
    s = Scheduler(root, {"max_concurrent_training": 1},
                  launcher=lambda d, r, detach=False: (_ for _ in ()).throw(
                      AssertionError("no worker may start without queued work")))
    out = s.cycle()
    assert out == {"started": [], "reaped": [], "evaluated": [], "governed": [],
                    "stalled": None}
    assert json.load(open(sentinel)) == {"run_id": "real-nse-001"}
    assert "exp-historical" not in ExperimentRegistry(root).exps


def test_aurix_cmd_exists_and_needs_no_args():
    path = os.path.join(REPO, "aurix.cmd")
    assert os.path.exists(path)
    src = open(path).read()
    assert "auto-train" in src and ".venv" in src
    assert "--dataset" not in src and "--run" not in src and "auto-submit" not in src


def _tiny_dataset(tmp):
    from aurix_ai.datasets import (DatasetSpec, build_features_labels,
                                   generate_ohlcv, write_dataset)
    bars = generate_ohlcv(7, 220, ("A",), 1700000000000)
    X, y, ts, inst = build_features_labels(bars, 5, 0.005)
    spec = DatasetSpec(dataset_id="t", version="v1", instruments=("A",),
                       n_bars=220, seed=7, horizon_bars=5, threshold=0.005,
                       start_ts=1700000000000)
    m = write_dataset(os.path.join(str(tmp), "ds"), spec, X, y, ts, inst)
    return os.path.join(str(tmp), "ds")


def _run_auto_train(runs, dsroot, *extra):
    import subprocess as _sp
    import sys
    return _sp.run([sys.executable, "-m", "aurix_ai.cli", "auto-train",
                    "--runs", runs, "--datasets", dsroot, "--once", *extra],
                   capture_output=True, text=True, timeout=120,
                   cwd=os.path.join(REPO, "services-python"))


def test_auto_train_once_end_to_end(tmp_path):
    import time
    runs = os.path.join(str(tmp_path), "runs")
    dsroot = _tiny_dataset(tmp_path)
    r = _run_auto_train(runs, dsroot)
    assert r.returncode == 0, r.stderr[-2000:]
    first = json.loads(r.stdout)
    assert first["status"] == "OK" and len(first["submitted"]) >= 1
    eid = first["submitted"][0]
    # Worker is an independent process doing real tiny training; wait for it.
    deadline = time.time() + 100
    manifest = None
    while time.time() < deadline:
        mp = os.path.join(runs, eid, "manifest.json")
        if os.path.exists(mp):
            manifest = json.load(open(mp))
            if manifest.get("status") == "COMPLETED":
                break
        time.sleep(2)
    assert manifest and manifest["status"] == "COMPLETED"
    assert manifest["dataset_version"].startswith("t-")
    assert os.path.exists(os.path.join(runs, eid, "checkpoints"))
    # Second invocation submits nothing new (duplicate protection).
    r2 = _run_auto_train(runs, dsroot)
    second = json.loads(r2.stdout)
    assert second["submitted"] == []
    # All artifacts stayed inside the isolated temp root.
    assert os.path.commonpath([runs]) == runs
