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
    json.dump({"model_type": "sgd-logloss", "n_windows": 1,
               "median_edge": 0.05, "experiment_id": eid,
               "dataset_version": "t"},
              open(os.path.join(edir, "walkforward_cv.json"), "w"))
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
    gates = _approved_gates()
    assert s.govern_eligible(gates) == [eid]
    assert s.reg.get(eid)["status"] == "REJECTED"
    gov = json.load(open(os.path.join(edir, "governance.json")))
    assert gov["outcome"] == "REJECTED" and gov["walkforward"]["median_test_sharpe"] == -0.5
    assert os.path.exists(os.path.join(edir, "walkforward.json"))


def test_stress_breach_rejects(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3} if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 99.0})
    gates = _approved_gates()
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


def test_missing_walkforward_policy_block_fails_closed(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    gates = {"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0,
             "stress": {"enabled": True, "max_stressed_dd_pct": 10.0}}
    s.govern_eligible(gates)
    assert s.reg.get(eid)["status"] == "FAILED"


def test_missing_stress_policy_block_fails_closed(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    gates = {"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0,
             "walkforward": {"enabled": True, "min_median_sharpe": 0.0}}
    s.govern_eligible(gates)
    assert s.reg.get(eid)["status"] == "FAILED"


def test_missing_all_extended_policy_blocks_fails_closed(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.govern_eligible({"min_oos_edge_vs_baseline": 0.01,
                       "max_backtest_drawdown_pct": 10.0})
    assert s.reg.get(eid)["status"] == "FAILED"


def test_missing_wf_bars_fails_closed(tmp_path):
    from aurix_ai.orchestrate import Scheduler
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    os.remove(os.path.join(s.root, "bars.json"))
    s.extended_runner = lambda b, e, mode: {"ok": True}
    # Base gate and extended gates fail closed without bars (REJECTED, never VALIDATED).
    s.govern_eligible(_approved_gates())
    assert s.reg.get(eid)["status"] == "REJECTED"
    # And the extended gate itself refuses missing bars as infra failure.
    import pytest
    with pytest.raises(Exception):
        s._extended_gate(eid, edir, os.path.join(s.root, "bars.json"),
                         "walkforward", {}, {})


def test_missing_stress_bars_fails_closed(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    # Remove bars file
    os.remove(os.path.join(s.root, "bars.json"))
    s.govern_eligible(_approved_gates())
    assert s.reg.get(eid)["status"] == "REJECTED"


def test_passing_holdout_cannot_override_failed_wf_or_stress(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.95, base=0.50)
    # Walkforward fails
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": -0.8} if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0})
    s.govern_eligible(_approved_gates())
    assert s.reg.get(eid)["status"] == "REJECTED"


def test_invalid_policy_configuration_fails_closed(tmp_path):
    import pytest
    from aurix_ai.orchestrate import validate_governance_gates
    from aurix_ai.errors import AITrainingError

    # Non-dict
    with pytest.raises(AITrainingError):
        validate_governance_gates("not a dict")

    # Missing min_oos_edge_vs_baseline
    with pytest.raises(AITrainingError):
        validate_governance_gates({"max_backtest_drawdown_pct": 10.0, "walkforward": {"enabled": True}, "stress": {"enabled": True}})

    # Non-numeric min_oos_edge_vs_baseline
    with pytest.raises(AITrainingError):
        validate_governance_gates({"min_oos_edge_vs_baseline": "invalid", "max_backtest_drawdown_pct": 10.0, "walkforward": {"enabled": True}, "stress": {"enabled": True}})

    # Negative min_oos_edge_vs_baseline
    with pytest.raises(AITrainingError):
        validate_governance_gates({"min_oos_edge_vs_baseline": -0.05, "max_backtest_drawdown_pct": 10.0, "walkforward": {"enabled": True}, "stress": {"enabled": True}})

    # Negative max_backtest_drawdown_pct
    with pytest.raises(AITrainingError):
        validate_governance_gates({"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": -5.0, "walkforward": {"enabled": True}, "stress": {"enabled": True}})

    # Non-boolean enabled
    with pytest.raises(AITrainingError):
        validate_governance_gates({"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0, "walkforward": {"enabled": "yes"}, "stress": {"enabled": True}, "classification_walkforward": {"enabled": True}})

    # Missing classification_walkforward
    with pytest.raises(AITrainingError):
        validate_governance_gates({"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0, "walkforward": {"enabled": True}, "stress": {"enabled": True}})

    # Invalid classification_walkforward min_median_edge
    with pytest.raises(AITrainingError):
        validate_governance_gates({"min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0, "walkforward": {"enabled": True}, "stress": {"enabled": True}, "classification_walkforward": {"enabled": True, "min_median_edge": "bad"}})


def test_success_reason_accurately_identifies_executed_gates(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.45, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 4.2, "scenarios": ["cost-x2", "friction-shock"]})
    s.govern_eligible(_approved_gates())
    assert s.reg.get(eid)["status"] == "VALIDATED"
    gov = json.load(open(os.path.join(edir, "governance.json")))
    assert gov["outcome"] == "VALIDATED"
    # Verify success reason on registry
    from aurix_ai.registry import ModelRegistry
    mreg = ModelRegistry(os.path.join(s.root, "model-registry.json"))
    model_entry = mreg.models[f"aurix-marketml-{eid}"]
    last_hist = model_entry["history"][-1]
    reason = last_hist["reason"]
    assert "oos edge 0.3000 >= 0.0100" in reason
    assert "backtest dd 1.0% <= 10.0%" in reason
    assert "wf median Sharpe 1.45 >= 0.00" in reason
    assert "stress max DD 4.2% <= 10.0%" in reason
    assert "classification wf median edge 0.0500 >= 0.0000" in reason
    # Ensure misleading static text is NOT present
    assert "backtest+wf+stress ok" not in reason


def _approved_gates(**over):
    gates = {"policy_version": "ai-policy-v1-test",
             "min_oos_edge_vs_baseline": 0.01, "max_backtest_drawdown_pct": 10.0,
             "walkforward": {"enabled": True, "min_median_sharpe": 0.0},
             "stress": {"enabled": True, "max_stressed_dd_pct": 10.0},
             "classification_walkforward": {"enabled": True, "min_median_edge": 0.0, "n_windows": 1}}
    gates.update(over)
    return gates


def test_malformed_gate_results_fail_closed(tmp_path):
    """Missing/unparsable gate fields can never authorize VALIDATED: malformed
    numeric results are infra failures (FAILED), vacuous ok-results reject."""
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    # ok:true but median missing -> FAILED (malformed), not VALIDATED.
    s.extended_runner = lambda b, e, mode: (
        {"ok": True} if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0})
    s.govern_eligible(_approved_gates())
    assert s.reg.get(eid)["status"] == "FAILED"
    # ok:true with zero evaluated windows -> REJECTED (vacuous), not VALIDATED.
    import tempfile
    with tempfile.TemporaryDirectory() as root:
        from aurix_ai.orchestrate import ExperimentRegistry, Scheduler
        reg = ExperimentRegistry(root)
        rec = reg.submit({"dataset_dir": root, "dataset_version": "t",
                          "model_type": "sgd-logloss",
                          "hyperparameters": {"alpha": 0.0001}, "seed": 7,
                          "epochs": 1, "device": "cpu",
                          "backtest_bars": os.path.join(root, "bars.json")})
        e2 = rec["experiment_id"]
        ed2 = os.path.join(root, e2)
        json.dump({"artifact_sha256": "abc"}, open(os.path.join(ed2, "manifest.json"), "w"))
        json.dump({"accuracy": 0.80, "baseline_majority_accuracy": 0.50,
                   "precision": 0.80, "recall": 0.80, "n": 200},
                  open(os.path.join(ed2, "eval.json"), "w"))
        json.dump(_bars(30), open(os.path.join(root, "bars.json"), "w"))
        s3 = Scheduler(root, {"max_concurrent_training": 1},
                       launcher=lambda d, r, detach=False: None,
                       backtest_runner=lambda b, e: {"ok": True, "max_drawdown_pct": 1.0})
        s3.extended_runner = lambda b, e, mode: (
            {"ok": True, "median_test_sharpe": 1.5, "windows": 0}
            if mode.startswith("walkforward")
            else {"ok": True, "max_stressed_dd": 1.0})
        s3.reg.transition(e2, "EVALUATED", "test")
        s3.govern_eligible(_approved_gates())
        assert s3.reg.get(e2)["status"] == "REJECTED"


def test_validated_requires_all_gates_and_records_policy(tmp_path):
    """A candidate reaches VALIDATED only when every required gate passes;
    the verdict records policy version + threshold snapshot for audit."""
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0,
              "scenarios": ["cost-x2", "friction-shock"]})
    s.govern_eligible(_approved_gates())
    assert s.reg.get(eid)["status"] == "VALIDATED"
    gov = json.load(open(os.path.join(edir, "governance.json")))
    assert gov["outcome"] == "VALIDATED"
    assert gov["policy_version"] == "ai-policy-v1-test"
    assert gov["gates"]["min_oos_edge_vs_baseline"] == 0.01
    assert gov["gates"]["walkforward"]["min_median_sharpe"] == 0.0
    assert gov["walkforward"]["median_test_sharpe"] == 1.5
    assert gov["stress"]["scenarios"] == ["cost-x2", "friction-shock"]
    assert gov["classification_walkforward"]["median_edge"] == 0.05
    assert os.path.exists(os.path.join(edir, "walkforward.json"))
    assert os.path.exists(os.path.join(edir, "stress.json"))
    assert os.path.exists(os.path.join(edir, "walkforward_cv.json"))


def test_missing_classification_walkforward_policy_block_fails_closed(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    gates = {
        "min_oos_edge_vs_baseline": 0.01,
        "max_backtest_drawdown_pct": 10.0,
        "walkforward": {"enabled": True, "min_median_sharpe": 0.0},
        "stress": {"enabled": True, "max_stressed_dd_pct": 10.0},
    }
    s.govern_eligible(gates)
    assert s.reg.get(eid)["status"] == "FAILED"


def test_missing_classification_walkforward_evidence_rejects(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0}
    )
    # Remove walkforward_cv.json
    os.remove(os.path.join(edir, "walkforward_cv.json"))
    s.govern_eligible(_approved_gates())
    assert s.reg.get(eid)["status"] == "REJECTED"
    gov = json.load(open(os.path.join(edir, "governance.json")))
    assert gov["outcome"] == "REJECTED"
    assert gov["classification_walkforward"]["ok"] is False
    assert "missing" in gov["classification_walkforward"]["reason"].lower()


def test_negative_classification_walkforward_edge_rejects(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0}
    )
    # Negative median edge in walkforward_cv.json
    with open(os.path.join(edir, "walkforward_cv.json"), "w") as f:
        json.dump({"model_type": "sgd-logloss", "n_windows": 4,
                   "median_edge": -0.0417, "experiment_id": eid,
                   "dataset_version": "t"}, f)
    s.govern_eligible(_approved_gates(classification_walkforward={"enabled": True, "min_median_edge": 0.0, "n_windows": 4}))
    assert s.reg.get(eid)["status"] == "REJECTED"
    gov = json.load(open(os.path.join(edir, "governance.json")))
    assert gov["outcome"] == "REJECTED"
    assert gov["classification_walkforward"]["ok"] is False
    assert "-0.0417" in gov["classification_walkforward"]["reason"]


def test_passing_classification_walkforward_edge_validates(tmp_path):
    s, eid, edir = _governed_fixture(tmp_path, acc=0.80, base=0.50)
    s.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0}
    )
    with open(os.path.join(edir, "walkforward_cv.json"), "w") as f:
        json.dump({"model_type": "sgd-logloss", "n_windows": 4,
                   "median_edge": 0.025, "experiment_id": eid,
                   "dataset_version": "t"}, f)
    s.govern_eligible(_approved_gates(classification_walkforward={"enabled": True, "min_median_edge": 0.0, "n_windows": 4}))
    assert s.reg.get(eid)["status"] == "VALIDATED"
    gov = json.load(open(os.path.join(edir, "governance.json")))
    assert gov["outcome"] == "VALIDATED"
    assert gov["classification_walkforward"]["ok"] is True
    assert gov["classification_walkforward"]["median_edge"] == 0.025


def test_classification_walkforward_provenance_mismatches_reject(tmp_path):
    # Model type mismatch
    s1, eid1, edir1 = _governed_fixture(tmp_path / "m1", acc=0.80, base=0.50)
    s1.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0}
    )
    with open(os.path.join(edir1, "walkforward_cv.json"), "w") as f:
        json.dump({"model_type": "wrong-model", "n_windows": 1,
                   "median_edge": 0.05, "experiment_id": eid1,
                   "dataset_version": "t"}, f)
    s1.govern_eligible(_approved_gates())
    assert s1.reg.get(eid1)["status"] == "REJECTED"
    gov1 = json.load(open(os.path.join(edir1, "governance.json")))
    assert "model_type mismatch" in gov1["classification_walkforward"]["reason"]

    # Experiment id mismatch
    s2, eid2, edir2 = _governed_fixture(tmp_path / "m2", acc=0.80, base=0.50)
    s2.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0}
    )
    with open(os.path.join(edir2, "walkforward_cv.json"), "w") as f:
        json.dump({"model_type": "sgd-logloss", "n_windows": 1,
                   "median_edge": 0.05, "experiment_id": "other-exp",
                   "dataset_version": "t"}, f)
    s2.govern_eligible(_approved_gates())
    assert s2.reg.get(eid2)["status"] == "REJECTED"
    gov2 = json.load(open(os.path.join(edir2, "governance.json")))
    assert "experiment_id mismatch" in gov2["classification_walkforward"]["reason"]

    # Dataset version mismatch
    s3, eid3, edir3 = _governed_fixture(tmp_path / "m3", acc=0.80, base=0.50)
    s3.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0}
    )
    with open(os.path.join(edir3, "walkforward_cv.json"), "w") as f:
        json.dump({"model_type": "sgd-logloss", "n_windows": 1,
                   "median_edge": 0.05, "experiment_id": eid3,
                   "dataset_version": "wrong-ds"}, f)
    s3.govern_eligible(_approved_gates())
    assert s3.reg.get(eid3)["status"] == "REJECTED"
    gov3 = json.load(open(os.path.join(edir3, "governance.json")))
    assert "dataset_version mismatch" in gov3["classification_walkforward"]["reason"]

    # Insufficient windows
    s4, eid4, edir4 = _governed_fixture(tmp_path / "m4", acc=0.80, base=0.50)
    s4.extended_runner = lambda b, e, mode: (
        {"ok": True, "median_test_sharpe": 1.5, "windows": 3}
        if mode.startswith("walkforward")
        else {"ok": True, "max_stressed_dd": 1.0}
    )
    with open(os.path.join(edir4, "walkforward_cv.json"), "w") as f:
        json.dump({"model_type": "sgd-logloss", "n_windows": 2,
                   "median_edge": 0.05, "experiment_id": eid4,
                   "dataset_version": "t"}, f)
    s4.govern_eligible(_approved_gates(classification_walkforward={"enabled": True, "min_median_edge": 0.0, "n_windows": 4}))
    assert s4.reg.get(eid4)["status"] == "REJECTED"
    gov4 = json.load(open(os.path.join(edir4, "governance.json")))
    assert "insufficient evaluated windows" in gov4["classification_walkforward"]["reason"]


def test_alternate_entry_points_enforce_classification_walkforward(tmp_path):
    from aurix_ai.orchestrate import load_policy_gates
    from aurix_ai.cli import _load_gates
    # Canonical loader loads classification_walkforward from policy
    _sched_cfg, gates1 = load_policy_gates()
    assert "classification_walkforward" in gates1
    assert gates1["classification_walkforward"]["enabled"] is True
    assert gates1["classification_walkforward"]["min_median_edge"] == 0.0
    assert gates1["classification_walkforward"]["n_windows"] == 4

    # CLI loader delegates to canonical loader
    _sched_cfg2, gates2 = _load_gates()
    assert gates2["classification_walkforward"] == gates1["classification_walkforward"]

