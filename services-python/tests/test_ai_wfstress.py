"""Walk-forward/stress governance (P1-3): gate script modes, orchestrator
wiring, rigged-winner blocking, infra-error handling. Synthetic bars in temp
dirs only; no market data, no real training."""

import json
import math
import os
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _bars(n=120):
    bars = []
    for i in range(n):
        for sym, base in (("NSE_EQ_A", 100.0), ("NSE_EQ_B", 50.0)):
            c = base + i * 0.5 + math.sin(i / 5.0) * 2.0
            bars.append({"instrument_id": sym, "ts": 1700000000000 + i * 86400000,
                         "open": c, "high": c + 1, "low": c - 1, "close": c,
                         "volume": 100000, "spread_bps": 5, "adv_value": 10000000})
    return bars


def _run_gate(bars_path, *mode):
    r = subprocess.run(
        ["node", "--import", "./scripts/aurix-register.mjs",
         "scripts/backtest-gate.mjs", bars_path, *mode],
        capture_output=True, text=True, timeout=120, cwd=REPO)
    assert r.returncode == 0, r.stderr[-2000:]
    lines = [l for l in r.stdout.strip().split("\n") if l.strip()]
    return json.loads(lines[-1])


def test_gate_walkforward_mode(tmp_path):
    p = os.path.join(str(tmp_path), "bars.json")
    json.dump(_bars(), open(p, "w"))
    out = _run_gate(p, "--walkforward=60,20,20,4")
    assert out["ok"] is True and out["status"] == "WALKFORWARD"
    assert out["windows"] >= 1
    test_froms = [w["testFrom"] for w in out["window_tests"]]
    assert test_froms == sorted(test_froms)
    assert out["median_test_sharpe"] is not None


def test_gate_walkforward_rejects_bad_spec(tmp_path):
    p = os.path.join(str(tmp_path), "bars.json")
    json.dump(_bars(10), open(p, "w"))
    out = _run_gate(p, "--walkforward=60,20,20,4")
    assert out["ok"] is False and out["reason"]


def test_gate_stress_mode(tmp_path):
    p = os.path.join(str(tmp_path), "bars.json")
    json.dump(_bars(), open(p, "w"))
    out = _run_gate(p, "--stress")
    assert out["ok"] is True and out["status"] == "STRESS"
    names = [s["scenario"] for s in out["scenarios"]]
    assert names == ["cost-x2", "friction-shock"]
    assert out["max_stressed_dd"] is not None


def _governed_fixture(tmp_path, acc=0.60, base=0.50):
    from aurix_ai.orchestrate import ExperimentRegistry, Scheduler
    root = str(tmp_path)
    reg = ExperimentRegistry(root)
    rec = reg.submit({"dataset_dir": root, "dataset_version": "t",
                      "model_type": "sgd-logloss",
                      "hyperparameters": {"alpha": 0.0001}, "seed": 7,
                      "epochs": 1, "device": "cpu",
                      "backtest_bars": os.path.join(root, "bars.json")})
    eid = rec["experiment_id"]
    edir = os.path.join(root, eid)
    json.dump({"artifact_sha256": "abc"}, open(os.path.join(edir, "manifest.json"), "w"))
    json.dump({"accuracy": acc, "baseline_majority_accuracy": base,
               "precision": acc, "recall": acc, "n": 200},
              open(os.path.join(edir, "eval.json"), "w"))
    json.dump(_bars(30), open(os.path.join(root, "bars.json"), "w"))
    s = Scheduler(root, {"max_concurrent_training": 1},
                  launcher=lambda d, r, detach=False: None,
                  backtest_runner=lambda b, e: {"ok": True, "max_drawdown_pct": 1.0})
    s.reg.transition(eid, "EVALUATED", "test")
    return s, eid, edir


def test_rigged_winner_blocked_by_walkforward(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": -0.5} if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0})
    gates = {"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0,
             "walkforward": {"enabled": True, "min_median_sharpe": 0.0},
             "stress": {"enabled": True, "max_stressed_dd_pct": 10.0}}
    assert s.govern_eligible(gates) == [eid]
    assert s.reg.get(eid)["status"] == "REJECTED"
    gov = json.load(open(os.path.join(edir, "governance.json")))
    assert gov["outcome"] == "REJECTED" and gov["walkforward"]["median_test_sharpe"] == -0.5
    assert os.path.exists(os.path.join(edir, "walkforward.json"))


def test_stress_breach_rejects(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5} if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 99.0})
    gates = {"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0,
             "walkforward": {"enabled": True, "min_median_sharpe": 0.0},
             "stress": {"enabled": True, "max_stressed_dd_pct": 10.0}}
    s.govern_eligible(gates)
    assert s.reg.get(eid)["status"] == "REJECTED"
    assert os.path.exists(os.path.join(edir, "stress.json"))


def test_extended_infra_failure_is_failed(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)

    def boom(bars, exp_dir, mode):
        raise RuntimeError("node exploded")

    s.extended_runner = boom
    gates = {"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0,
             "walkforward": {"enabled": True}}
    s.govern_eligible(gates)
    assert s.reg.get(eid)["status"] == "FAILED"


def test_gates_absent_preserves_legacy_behavior(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.govern_eligible({"min_oos_edge_vs_baseline": 0.01,
                       "max_backtest_drawdown_pct": 10.0})
    assert s.reg.get(eid)["status"] == "VALIDATED"


def test_missing_wf_bars_fails_closed(tmp_path):
    from aurix_ai.orchestrate import Scheduler
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    os.remove(os.path.join(s.root, "bars.json"))
    s.extended_runner = lambda b, e, mode: {"ok": True}
    # Base gate already fails closed without bars (REJECTED, never VALIDATED).
    s.govern_eligible({"min_oos_edge_vs_baseline": 0.01,
                       "max_backtest_drawdown_pct": 10.0,
                       "walkforward": {"enabled": True}})
    assert s.reg.get(eid)["status"] == "REJECTED"
    # And the extended gate itself refuses missing bars as infra failure.
    import pytest
    with pytest.raises(Exception):
        s._extended_gate(eid, edir, os.path.join(s.root, "bars.json"),
                         "walkforward", {}, {})
