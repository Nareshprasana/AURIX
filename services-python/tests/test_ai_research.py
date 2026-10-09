"""Autonomous research agent tests: outcome-driven planning, validation,
budgets, idempotency, safe LLM handling, governance isolation.
Temp roots + tiny synthetic datasets only. No training runs, no network."""

import json
import os


def _tiny_dataset(tmp, name="t", seed=7, bars=220):
    from aurix_ai.datasets import (DatasetSpec, build_features_labels,
                                   generate_ohlcv, write_dataset)
    bars_d = generate_ohlcv(seed, bars, ("A",), 1700000000000)
    X, y, ts, inst = build_features_labels(bars_d, 5, 0.005)
    spec = DatasetSpec(dataset_id=name, version="v1", instruments=("A",),
                       n_bars=bars, seed=seed, horizon_bars=5, threshold=0.005,
                       start_ts=1700000000000)
    m = write_dataset(os.path.join(str(tmp), "dsroot"), spec, X, y, ts, inst)
    return os.path.join(str(tmp), "dsroot", m["dataset_version"])


def _submit_raw(root, dsdir, seed=7, epochs=1):
    from aurix_ai.orchestrate import ExperimentRegistry
    reg = ExperimentRegistry(root)
    rec = reg.submit({"dataset_dir": dsdir, "dataset_version": "t",
                      "model_type": "sgd-logloss",
                      "hyperparameters": {"alpha": 0.0001, "random_state": 7},
                      "seed": seed, "epochs": epochs, "device": "cpu"})
    return reg, rec


def _finish_rejected(reg, root, eid, edge=-0.02):
    edir = os.path.join(root, eid)
    with open(os.path.join(edir, "manifest.json"), "w") as f:
        json.dump({"status": "COMPLETED"}, f)
    with open(os.path.join(edir, "eval.json"), "w") as f:
        json.dump({"accuracy": 0.5 + edge, "baseline_majority_accuracy": 0.5,
                   "precision": 0.5, "recall": 0.5, "n": 100}, f)
    with open(os.path.join(edir, "governance.json"), "w") as f:
        json.dump({"outcome": "REJECTED", "edge": edge, "backtest_ok": False}, f)
    reg.transition(eid, "RUNNING", "t")
    reg.transition(eid, "REJECTED", "edge below minimum")


POLICY = {"max_experiments_per_cycle": 3, "research_max_total": 12,
          "research_max_per_cycle": 3, "default_epochs": 1,
          "market_ml": {"hyperparameters": {"alpha": 0.0001}}}


def test_questions_from_rejected_outcome(tmp_path):
    from aurix_ai.research import run_cycle
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    adj = ds + "-adjusted-twin"
    os.makedirs(adj)
    import shutil
    for f in ("features.csv", "manifest.json"):
        shutil.copy(os.path.join(ds, f), os.path.join(adj, f))
    os.rename(adj, ds + "-adjusted")
    adj = ds + "-adjusted"
    reg, rec = _submit_raw(root, ds)
    _finish_rejected(reg, root, rec["experiment_id"])
    plan = run_cycle(root, [ds, adj], POLICY, dry_run=True)
    topics = [q["question"] for q in plan["questions"]]
    assert plan["conclusions"] == [rec["experiment_id"]]
    assert topics, "rejected outcome must yield a follow-up question"


def test_invalid_proposals_rejected(tmp_path):
    from aurix_ai.research import validate_proposal
    root = os.path.join(str(tmp_path), "runs")
    os.makedirs(root, exist_ok=True)
    ds = _tiny_dataset(tmp_path)
    with __import__("pytest").raises(Exception):
        validate_proposal({"dataset_dir": "/nope", "model_type": "sgd-logloss",
                           "hyperparameters": {}, "seed": 1, "epochs": 1}, root, [ds])
    with __import__("pytest").raises(Exception):
        validate_proposal({"dataset_dir": ds, "model_type": "llm-oracle",
                           "hyperparameters": {}, "seed": 1, "epochs": 1}, root, [ds])
    with __import__("pytest").raises(Exception):
        validate_proposal({"dataset_dir": ds, "model_type": "sgd-logloss",
                           "hyperparameters": {"hacker": 1}, "seed": 1,
                           "epochs": 1}, root, [ds])
    ok = validate_proposal({"dataset_dir": ds, "model_type": "sgd-logloss",
                            "hyperparameters": {"alpha": 0.0001}, "seed": 1,
                            "epochs": 1}, root, [ds])
    assert ok["_fingerprint"]


def test_duplicates_never_resubmitted(tmp_path):
    from aurix_ai.research import run_cycle
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    p1 = run_cycle(root, [ds], POLICY, dry_run=False)
    assert len(p1["submitted"]) >= 1
    p2 = run_cycle(root, [ds], POLICY, dry_run=False)
    assert p2["submitted"] == []  # same fingerprints refused


def test_selection_uses_history(tmp_path):
    from aurix_ai.research import run_cycle
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    first = run_cycle(root, [ds], POLICY, dry_run=True)
    assert any("baseline" in q["question"].lower() for q in first["questions"])
    adj = ds + "-adjusted2"
    os.makedirs(adj)
    import shutil
    for f in ("features.csv", "manifest.json"):
        shutil.copy(os.path.join(ds, f), os.path.join(adj, f))
    from aurix_ai.orchestrate import ExperimentRegistry
    live = run_cycle(root, [ds], POLICY, dry_run=False)
    assert live["submitted"], "baseline experiment must be submitted"
    eid = live["submitted"][0]
    _finish_rejected(ExperimentRegistry(root), root, eid)
    nxt = run_cycle(root, [ds, adj], POLICY, dry_run=True)
    assert any("adjust" in q["question"].lower() for q in nxt["questions"])


def test_negatives_persist_and_discoverable(tmp_path):
    from aurix_ai.research import read_research_log, run_cycle
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    from aurix_ai.orchestrate import ExperimentRegistry
    reg, rec = _submit_raw(root, ds)
    _finish_rejected(reg, root, rec["experiment_id"])
    run_cycle(root, [ds], POLICY, dry_run=True)
    log = read_research_log(root)
    concl = [r for r in log if r.get("record") == "conclusion"]
    assert concl and concl[0]["outcome_class"] == "GOVERNANCE_REJECTED"
    assert concl[0]["assertion"] == "OBSERVATION"


def test_infra_failure_not_model_quality(tmp_path):
    from aurix_ai.research import classify_outcome, run_cycle
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    from aurix_ai.orchestrate import ExperimentRegistry
    reg, rec = _submit_raw(root, ds)
    eid = rec["experiment_id"]
    reg.transition(eid, "RUNNING", "t")
    reg.transition(eid, "FAILED", "worker died")
    cls = classify_outcome({"experiment_id": eid, "status": "FAILED",
                            "definition": {}, "manifest": None, "eval": None,
                            "governance": None, "backtest": None}, None)
    assert cls["class"] == "INFRA_FAILURE"
    plan = run_cycle(root, [ds], POLICY, dry_run=True)
    concl = [r for r in plan["conclusions"] if r == eid]
    assert concl


def test_budgets_enforced(tmp_path):
    from aurix_ai.research import run_cycle
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    tight = dict(POLICY, research_max_per_cycle=1, research_max_total=1)
    plan = run_cycle(root, [ds], tight, dry_run=False)
    assert len(plan["submitted"]) <= 1
    plan2 = run_cycle(root, [ds], tight, dry_run=False)
    assert plan2["submitted"] == []
    assert any("budget" in s for s in plan2["skipped"])


def test_restart_no_duplicates(tmp_path):
    from aurix_ai.research import read_research_log, run_cycle
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    run_cycle(root, [ds], POLICY, dry_run=True)
    n1 = len(read_research_log(root))
    ids1 = sorted(r.get("id") for r in read_research_log(root) if r.get("id"))
    run_cycle(root, [ds], POLICY, dry_run=True)
    log2 = read_research_log(root)
    ids2 = sorted(r.get("id") for r in log2 if r.get("id"))
    assert ids1 == ids2 and len(log2) == n1
    assert len(ids2) == len(set(ids2))


def test_malformed_llm_fails_safe(tmp_path):
    from aurix_ai.research import run_cycle
    root = os.path.join(str(tmp_path), "runs")
    ds = _tiny_dataset(tmp_path)
    plan = run_cycle(root, [ds], POLICY, llm_json={"bogus": True}, dry_run=True)
    assert any(s.startswith("llm:") for s in plan["skipped"])
    assert plan["questions"], "deterministic path must still proceed"


def test_no_governance_bypass_possible():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                            "aurix_ai", "research.py"), encoding="utf-8").read()
    assert "ModelRegistry" not in src
    assert "promote(" not in src
    assert "mreg.register" not in src
    # Reading a VALIDATED outcome as evidence is allowed; writing promotion is not.
