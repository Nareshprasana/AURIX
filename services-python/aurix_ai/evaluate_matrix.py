"""Authorized Real-Market Evaluation Matrix: feat-v1 vs feat-v2 (LogReg and TorchMLP).

Strict safety constraints:
  - CPU only, no GPU, no broker connectivity, no live trading.
  - Sequential single-worker execution.
  - Strict 180s total execution budget.
  - Preserves all historical runs and datasets.
"""

from __future__ import annotations

import json
import os
import time
import numpy as np

from aurix_ai.datasets import load_dataset
from aurix_ai.orchestrate import (
    ExperimentRegistry,
    Scheduler,
    emit_event,
    runs_root,
    utc_ms,
)
from aurix_ai.worker import run_worker
from aurix_ai.train import walk_forward_cv, evaluate_proba


def run_matrix(root_dir: str | None = None) -> dict:
    t_start = time.time()
    root = runs_root(root_dir)
    reg = ExperimentRegistry(root)

    # 1. Dataset paths
    ds_v1_dir = os.path.abspath("data/datasets/aurix-nse-daily-adjusted-410acb26a9ee")
    ds_v2_dir = os.path.abspath("data/datasets/aurix-nse-daily-adjusted-feat-v2-62a3d04c68c5")

    # Load datasets for walk-forward evaluation
    X_v1, y_v1, ts_v1, inst_v1, man_v1 = load_dataset(ds_v1_dir)
    X_v2, y_v2, ts_v2, inst_v2, man_v2 = load_dataset(ds_v2_dir)

    # 2. Experiment specifications (4-cell matrix)
    experiments_def = [
        {
            "cell": "LogReg / feat-v1",
            "model_type": "logreg-lbfgs",
            "feature_version": "feat-v1",
            "dataset_dir": ds_v1_dir,
            "dataset_version": man_v1["dataset_version"],
            "hyperparameters": {"alpha": 0.0001, "random_state": 7},
            "seed": 7,
            "epochs": 5,
            "device": "cpu",
            "backtest_bars": os.path.abspath("data/processed/aurix-nse-daily-adjusted-410acb26a9ee/backtest-bars.json"),
            "price_basis": man_v1.get("adjustment_policy", "split-bonus-adjusted"),
            "data_source": man_v1.get("source", "eod2-data"),
        },
        {
            "cell": "LogReg / feat-v2",
            "model_type": "logreg-lbfgs",
            "feature_version": "feat-v2",
            "dataset_dir": ds_v2_dir,
            "dataset_version": man_v2["dataset_version"],
            "hyperparameters": {"alpha": 0.0001, "random_state": 7},
            "seed": 7,
            "epochs": 5,
            "device": "cpu",
            "backtest_bars": os.path.abspath("data/processed/aurix-nse-daily-adjusted-feat-v2-62a3d04c68c5/backtest-bars.json"),
            "price_basis": man_v2.get("adjustment_policy", "split-bonus-adjusted"),
            "data_source": man_v2.get("source", "eod2-data"),
        },
        {
            "cell": "TorchMLP / feat-v1",
            "model_type": "torch-mlp",
            "feature_version": "feat-v1",
            "dataset_dir": ds_v1_dir,
            "dataset_version": man_v1["dataset_version"],
            "hyperparameters": {
                "hidden_dims": (32, 16),
                "lr": 0.001,
                "batch_size": 64,
                "weight_decay": 0.0001,
                "activation": "relu",
                "random_state": 7,
            },
            "seed": 7,
            "epochs": 10,
            "device": "cpu",
            "backtest_bars": os.path.abspath("data/processed/aurix-nse-daily-adjusted-410acb26a9ee/backtest-bars.json"),
            "price_basis": man_v1.get("adjustment_policy", "split-bonus-adjusted"),
            "data_source": man_v1.get("source", "eod2-data"),
        },
        {
            "cell": "TorchMLP / feat-v2",
            "model_type": "torch-mlp",
            "feature_version": "feat-v2",
            "dataset_dir": ds_v2_dir,
            "dataset_version": man_v2["dataset_version"],
            "hyperparameters": {
                "hidden_dims": (32, 16),
                "lr": 0.001,
                "batch_size": 64,
                "weight_decay": 0.0001,
                "activation": "relu",
                "random_state": 7,
            },
            "seed": 7,
            "epochs": 10,
            "device": "cpu",
            "backtest_bars": os.path.abspath("data/processed/aurix-nse-daily-adjusted-feat-v2-62a3d04c68c5/backtest-bars.json"),
            "price_basis": man_v2.get("adjustment_policy", "split-bonus-adjusted"),
            "data_source": man_v2.get("source", "eod2-data"),
        },
    ]

    from .cli import _load_gates, _node_backtest_runner, _node_gate_runner
    sched_cfg, gates = _load_gates()
    sched = Scheduler(root, sched_cfg, backtest_runner=_node_backtest_runner, extended_runner=_node_gate_runner)
    results = []

    for defn in experiments_def:
        cell_name = defn["cell"]
        t_cell_start = time.time()
        print(f"\n==========================================")
        print(f"Executing: {cell_name}")
        print(f"==========================================")

        # Budget check: 180s total cap
        elapsed_total = time.time() - t_start
        if elapsed_total > 150:  # Safety margin before 180s cap
            print(f"WARNING: Approaching 180s budget limit ({elapsed_total:.1f}s elapsed). Stopping safely.")
            results.append({"cell": cell_name, "status": "BUDGET_CAPPED", "reason": "180s budget protection"})
            break

        from .orchestrate import experiment_id
        eid = experiment_id(defn)
        exp_dir = os.path.join(root, eid)
        print(f"Experiment ID: {eid} (directory: {exp_dir})")

        if eid in sched.reg.exps:
            rec = sched.reg.exps[eid]
        else:
            rec = sched.reg.submit(defn)

        # 1. Run Worker Training if not yet completed
        if rec["status"] in ("QUEUED", "RUNNING"):
            emit_event(exp_dir, eid, "TRAINING_STARTED", {
                "dataset_version": defn["dataset_version"],
                "model_type": defn["model_type"],
                "worker": os.getpid(),
            })
            rc = run_worker(exp_dir, resume=False)
            if rc != 0:
                print(f"ERROR: Worker failed for {eid}")
                results.append({"cell": cell_name, "experiment_id": eid, "status": "FAILED", "error": "worker exited non-zero"})
                continue
            sched.reg.transition(eid, "COMPLETED", f"trained in {time.time() - t_cell_start:.1f}s")
            emit_event(exp_dir, eid, "TRAINING_COMPLETED", {"epochs": defn["epochs"], "worker": os.getpid()})

        # 2. Canonical Chronological Out-of-Sample Evaluation
        if sched.reg.exps[eid]["status"] == "COMPLETED":
            ev = sched.evaluate(eid)
        else:
            ev = json.load(open(os.path.join(exp_dir, "eval.json")))
        print(f"Canonical OOS Eval: Accuracy={ev['accuracy']:.4f}, Majority Baseline={ev['baseline_majority_accuracy']:.4f}, Edge={ev['accuracy'] - ev['baseline_majority_accuracy']:.4f}")

        # 3. Walk-Forward Cross-Validation (4 windows, train 500, purge 10, test 120, step 120)
        wf_path = os.path.join(exp_dir, "walkforward_cv.json")
        if os.path.exists(wf_path):
            wf_res = json.load(open(wf_path))
        else:
            X_cur = X_v1 if defn["feature_version"] == "feat-v1" else X_v2
            y_cur = y_v1
            wf_res = walk_forward_cv(
                X_cur, y_cur,
                model_type=defn["model_type"],
                model_config=defn["hyperparameters"],
                n_windows=4,
                train_bars=500,
                test_bars=120,
                step_bars=120,
                purge_bars=10,
                epochs=defn["epochs"],
                seed=defn["seed"],
            )
            with open(wf_path, "w") as f:
                json.dump(wf_res, f, indent=2)
        print(f"Walk-Forward CV: Mean Edge={wf_res['mean_edge']:.4f}, Median Edge={wf_res['median_edge']:.4f}, Mean Acc={wf_res['mean_accuracy']:.4f}")

        # 4. Governance Evaluation
        gov_path = os.path.join(exp_dir, "governance.json")
        if sched.reg.exps[eid]["status"] == "EVALUATED":
            from .orchestrate import load_policy_gates
            _sched_cfg, gates = load_policy_gates()
            gov = sched.govern(eid, gates)
        else:
            gov = json.load(open(gov_path)) if os.path.exists(gov_path) else {"outcome": sched.reg.exps[eid]["status"]}
        print(f"Governance Verdict: {gov.get('outcome')} (Edge={gov.get('edge')}, Min={gov.get('min_edge')})")

        elapsed_cell = time.time() - t_cell_start
        results.append({
            "cell": cell_name,
            "experiment_id": eid,
            "model_type": defn["model_type"],
            "feature_version": defn["feature_version"],
            "dataset_version": defn["dataset_version"],
            "canonical_eval": ev,
            "walk_forward_cv": wf_res,
            "governance": gov,
            "elapsed_s": round(elapsed_cell, 2),
        })

    total_time = time.time() - t_start
    summary = {
        "status": "COMPLETED",
        "total_elapsed_s": round(total_time, 2),
        "experiments": results,
    }
    with open(os.path.join(root, "feat_v2_real_market_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    return summary


if __name__ == "__main__":
    import sys
    out = run_matrix()
    print("\n==========================================")
    print("Matrix Execution Finished Successfully!")
    print(f"Total Wall-Clock Time: {out['total_elapsed_s']}s")
    print("==========================================")
