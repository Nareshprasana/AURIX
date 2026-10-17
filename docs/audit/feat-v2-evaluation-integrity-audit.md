# AURIX Evaluation Integrity, Governance Consistency & Artifact Audit

**Audit Date:** 2026-10-17  
**Auditor:** AURIX Engineering / Antigravity Pair Programmer  
**Milestone:** Evaluation Integrity, Governance Consistency & Artifact Audit  
**Operating Policy Reference:** `AGENTS.md` (§1-§12), `config/ai-policy.v1.yaml`  
**Audit Scope:** Real-market experiment matrix (`feat-v1` vs `feat-v2` across `LogRegLBFGS` and `TorchMLP`), evaluation routines, probability outputs, walk-forward CV, registry entries, and governance verdicts. Strictly audit-only; zero retraining or model promotion authorized.

---

## 1. Executive Summary & Audit Verdict

### Overall Credibility Verdict: **COMPUTATIONALLY ACCURATE ON RECORDED TEST PARTITIONS, BUT GOVERNANCE VERDICT IS FLAWED BY CONFIGURATION DIVERGENCE**

1. **Artifact Authenticity & Numerical Integrity:**
   - All four experiment directories (`exp-bd0e57cb0d`, `exp-5032fc2873`, `exp-e7014f0467`, `exp-23c331d5be`) are 100% authentic and uncorrupted.
   - Every on-disk `final/artifact.joblib` matches the SHA-256 hash recorded in its corresponding `manifest.json` bit-for-bit.
   - Independent, clean-room recomputation of out-of-sample metrics (`accuracy`, `balanced_accuracy`, `brier_score`, `log_loss`, `confusion_matrix`) from raw weights and test feature matrices reproduced the saved `eval.json` files with 100% precision.

2. **The High Log Loss Mystery (4.0820 & 5.6215):**
   - The extreme log loss values are **not** an indexing bug, label inversion, or corrupted prediction pipeline.
   - They are caused by **uncalibrated sigmoid probabilities** produced by linear/MLP models on market feature outliers.
   - Raw logits reach extreme bounds (e.g. $[-28.34, +37.95]$ in `feat-v1` and $[-34.39, +43.73]$ in `feat-v2`). Over 100 out of 288 holdout bars produce $|z| > 10$, forcing probabilities to saturate against floating-point epsilon ($10^{-15}$).
   - When an overconfident prediction is wrong (e.g. model outputs $p_1 = 1 - 10^{-15}$ when $y = 0$), cross-entropy penalizes that single sample by $-\ln(10^{-15}) = 34.5396$.
   - Just 5 extreme outlier misclassifications in holdout data contribute $>136.5$ cross-entropy points, inflating mean log loss to $4.0820$, even though the **median cross-entropy is only $0.3209$** and 0/1 accuracy is $54.51\%$.

3. **The Governance Discrepancy (`VALIDATED` with Negative Mean Walk-Forward Edge):**
   - In `services-python/aurix_ai/evaluate_matrix.py` (lines 193-197), the evaluation runner constructed an isolated, hardcoded `gates` dictionary:
     ```python
     gates = {
         "min_oos_edge_vs_baseline": 0.01,
         "max_backtest_drawdown_pct": 10.0,
         "policy_version": "v1.0",
     }
     ```
   - This hardcoded dictionary omitted the mandatory `"walkforward"` and `"stress"` sections that are normally loaded from `config/ai-policy.v1.yaml` by `_load_gates()`.
   - In `services-python/aurix_ai/orchestrate.py` (line 584), `Scheduler.govern()` checks `if wf_cfg.get("enabled", False)`. Because `wf_cfg` defaulted to empty `{}`, walk-forward backtest gating was completely bypassed.
   - Furthermore, `walk_forward_cv()` in `evaluate_matrix.py` was executed independently as an analytical diagnostic and dumped to `walkforward_cv.json`; `Scheduler.govern()` has no architectural hook to evaluate `walkforward_cv.json`.
   - Consequently, `Scheduler.govern()` only evaluated the single canonical holdout split in `eval.json`, where `exp-bd0e57cb0d` had edge $+0.0417$ and `exp-e7014f0467` had edge $+0.0278$ ($> 0.01$).
   - `Scheduler.govern()` then executed the promotion block, printing a misleading hardcoded reason string `f"oos edge {edge:.4f} >= {min_edge}; backtest+wf+stress ok"`, and promoted both models to `VALIDATED` in `data/runs/registry.json` and `data/runs/model-registry.json`.

4. **Production Readiness Verdict:**
   - **ZERO CANDIDATES ARE DEPLOYMENT-READY.**
   - All four candidates exhibit negative mean rolling walk-forward edge ($-0.0917$, $-0.0896$, $-0.1146$, $-0.1000$).
   - When evaluated across sequential time windows with a 10-bar purge buffer, none demonstrated repeatable predictive power.
   - Under a fully enforced walk-forward gate, **ALL FOUR CANDIDATES WOULD BE REJECTED**.

---

## 2. Preflight, Environment & Repository Integrity

- **Operating System:** Windows 11 (PowerShell)
- **Repository Branch:** `main`
- **Starting Git HEAD:** `bfd8a6593c8c80d17dced207d6c4538642494678`
- **Active Processes Check:** Confirmed zero training workers or supervisors active. Only background Graphify serve instances (PIDs 25392, 25968) running.
- **Historical Runs & Datasets Preservation:**
  - `exp-3f735a1a54`, `exp-44a10dbe50`, `exp-d466527aff` intact and untouched.
  - `aurix-nse-daily-0cd820389cb2` and `aurix-nse-daily-adjusted-410acb26a9ee` datasets untouched.
- **Audited Target Artifacts:**
  - `data/runs/exp-bd0e57cb0d` (LogReg / feat-v1)
  - `data/runs/exp-5032fc2873` (LogReg / feat-v2)
  - `data/runs/exp-e7014f0467` (TorchMLP / feat-v1)
  - `data/runs/exp-23c331d5be` (TorchMLP / feat-v2)
  - `data/runs/feat_v2_real_market_summary.json`
  - `data/runs/registry.json`
  - `data/runs/model-registry.json`
- **Test Suite Health:**
  - Python test suite: 171 passed in 47.40s (`pytest`).
  - Vitest test suite: 80 test files passed, 473 tests passed in 16.78s (`vitest run`).
  - Safety boundary lint: `node scripts/lint.mjs` passed cleanly.

---

## 3. Graphify Architecture Tracing & Impact Analysis

Graphify MCP and CLI tools were queried to inspect connections between evaluation, prediction, governance, and registries:

1. **Shortest Path: `evaluate_proba()` to `Scheduler`:**
   ```
   evaluate_proba() --[imports]--> orchestrate.py --[imports_from]--> worker.py --[rationale_for]--> Training worker
   ```
2. **God Node Tracing:**
   - `Scheduler` (`services-python/aurix_ai/orchestrate.py:L332`) owns `evaluate()` and `govern()`.
   - `evaluate()` loads `load_dataset()`, runs `predict_proba_from_artifact()`, calls `evaluate_proba()`, and writes `eval.json`.
   - `govern()` reads `eval.json` and `backtest.json`, tests `min_oos_edge_vs_baseline` and `max_backtest_drawdown_pct`, evaluates `_extended_gate()` (only if enabled in gates dict), and calls `ModelRegistry.promote()`.
3. **Architectural Separation:**
   - ML metric cross-validation (`walk_forward_cv()`) is defined in `train.py` and called by `evaluate_matrix.py`.
   - `Scheduler.govern()` has no edge or import connecting to `walk_forward_cv()`. It only looks for `bars_path` to invoke `extended_runner` (the Node backtest script).

---

## 4. Probability Outputs, Logits & Metric Audit

### Audit Methodology
A clean-room verification script loaded the persisted `final/artifact.joblib` for each run, applied the exact learned scaler parameters `scaler_mean` and `scaler_var`, extracted logits $z = X_{\text{scaled}} \cdot w + b$ (or MLP forward pass), computed sigmoid probabilities $p_1 = \sigma(z)$, and calculated sample-by-sample binary cross-entropy and Brier score.

### Empirical Findings Table

| Metric / Property | LogReg / feat-v1 (`exp-bd0e57cb0d`) | LogReg / feat-v2 (`exp-5032fc2873`) | TorchMLP / feat-v1 (`exp-e7014f0467`) | TorchMLP / feat-v2 (`exp-23c331d5be`) |
| :--- | :--- | :--- | :--- | :--- |
| **Model Type** | `logreg-lbfgs` | `logreg-lbfgs` | `torch-mlp` | `torch-mlp` |
| **Features** | `feat-v1` (5 cols) | `feat-v2` (12 cols) | `feat-v1` (5 cols) | `feat-v2` (12 cols) |
| **Holdout Samples ($n$)** | 288 | 288 | 288 | 288 |
| **Logits Min / Max** | -28.3383 / +37.9523 | -34.3868 / +43.7278 | -16.6103 / +24.7643 | -19.3512 / +22.3932 |
| **Logits Mean $\pm$ Std** | -0.1988 $\pm$ 11.4179 | +4.6112 $\pm$ 14.2671 | +0.2119 $\pm$ 7.2968 | +2.3809 $\pm$ 6.7956 |
| **Bars with $|z| > 10$** | 108 (37.5%) | 145 (50.3%) | 45 (15.6%) | 45 (15.6%) |
| **$p_1$ Min / Max** | 0.00000000 / 1.00000000 | 0.00000000 / 1.00000000 | 0.00000006 / 1.00000000 | 0.00000000 / 1.00000000 |
| **$p_1$ 5th / 95th Pct** | 0.00000001 / 1.00000000 | 0.00000007 / 1.00000000 | 0.00002331 / 0.99999888 | 0.00018959 / 0.99999934 |
| **Holdout Accuracy** | **54.5139%** | **48.2639%** | **53.1250%** | **50.3472%** |
| **Majority Baseline** | 50.3472% | 50.3472% | 50.3472% | 50.3472% |
| **Canonical Edge** | **+0.041667** | **-0.020833** | **+0.027778** | **0.000000** |
| **Sample Cross-Entropy Max** | 34.5396 | 34.5396 | 24.7643 | 19.3512 |
| **Sample Cross-Entropy Median** | **0.3209** | **1.0120** | **0.4124** | **0.6815** |
| **Reported Mean Log Loss** | **4.082003** | **5.621479** | **2.655141** | **2.756746** |
| **Recomputed Mean Log Loss** | **4.082003** | **5.621479** | **2.655141** | **2.756746** |
| **Brier Score** | 0.432273 | 0.474125 | 0.411431 | 0.435118 |

### Mathematical Proof of the Log Loss Anomaly

Cross-entropy loss for binary classification is defined as:
$$\mathcal{L} = -\frac{1}{N} \sum_{i=1}^N \left[ y_i \ln(\hat{p}_i) + (1 - y_i) \ln(1 - \hat{p}_i) \right]$$
where $\hat{p}_i = \text{clip}(p_i, \epsilon, 1 - \epsilon)$ with $\epsilon = 10^{-15}$.

When $|z_i| > 35$:
$$\hat{p}_i \ge 1 - 10^{-15} \implies \ln(1 - \hat{p}_i) = \ln(10^{-15}) \approx -34.53957599$$

In `exp-bd0e57cb0d` (LogReg / feat-v1), the top 5 worst loss contributions in the test set were:
- **Sample #26:** True $y = 0$, predicted $p_1 = 1.00000000$ $\implies \text{loss} = 34.5396$
- **Sample #207:** True $y = 0$, predicted $p_1 = 1.00000000$ $\implies \text{loss} = 30.0275$
- **Sample #28:** True $y = 0$, predicted $p_1 = 1.00000000$ $\implies \text{loss} = 24.6921$
- **Sample #24:** True $y = 0$, predicted $p_1 = 1.00000000$ $\implies \text{loss} = 24.5132$
- **Sample #182:** True $y = 0$, predicted $p_1 = 1.00000000$ $\implies \text{loss} = 22.7858$

**Top 5 samples total loss contribution:**
$$34.5396 + 30.0275 + 24.6921 + 24.5132 + 22.7858 = 136.5582$$
$$\frac{136.5582}{288} = 0.4742 \text{ added to the mean loss from just 5 bars!}$$

Because identical high-volatility market days exist across features, samples #26, #28, #203, and #207 appear as extreme overconfident errors across both Logistic Regression and TorchMLP.
Conclusion: The high log loss is an **uncalibrated probability penalty**, reflecting the heavy penalty exacted by logarithmic scoring on overconfident wrong predictions.

---

## 5. Walk-Forward Cross-Validation Audit

Walk-forward cross-validation was audited directly from `walkforward_cv.json` across all four experiments.

### Window Specification & Purge Buffer Integrity
The walk-forward protocol evaluated 4 sequential rolling windows:
- **Train Window Length:** 500 bars
- **Purge Gap:** 10 bars (strictly enforced between `train_range[1]` and `test_range[0]`)
- **Test Window Length:** 120 bars
- **Step Size:** 120 bars

Verification of window index boundaries:
- **Window 0:** Train `[0, 500]`, Purge `(500, 510)`, Test `[510, 630]` $\implies$ Purge Gap = 10 bars
- **Window 1:** Train `[120, 620]`, Purge `(620, 630)`, Test `[630, 750]` $\implies$ Purge Gap = 10 bars
- **Window 2:** Train `[240, 740]`, Purge `(740, 750)`, Test `[750, 870]` $\implies$ Purge Gap = 10 bars
- **Window 3:** Train `[360, 860]`, Purge `(860, 870)`, Test `[870, 990]` $\implies$ Purge Gap = 10 bars

**Purge & Leakage Verdict:** PASS. Zero index overlap exists between training and testing sets. Scaler fitting was strictly performed on the training split only (`fit_transform` on train, `transform` on test).

### Window Performance Breakdown

#### 1. LogReg / feat-v1 (`exp-bd0e57cb0d`)
- Window 0: Acc 65.83%, Base 60.83%, Edge **+0.0500**, Brier 0.2351, LogLoss 0.6638
- Window 1: Acc 46.67%, Base 55.83%, Edge **-0.0917**, Brier 0.2788, LogLoss 0.7547
- Window 2: Acc 56.67%, Base 55.83%, Edge **+0.0083**, Brier 0.2400, LogLoss 0.6727
- Window 3: Acc 33.33%, Base 66.67%, Edge **-0.3333**, Brier 0.3032, LogLoss 0.8074
- **Mean Accuracy:** 50.6250% | **Mean Edge:** **-0.091667** | **Median Edge:** **-0.041667** | **Mean Log Loss:** 0.724624

#### 2. LogReg / feat-v2 (`exp-5032fc2873`)
- Window 0: Acc 64.17%, Base 60.83%, Edge **+0.0333**, Brier 0.2392, LogLoss 0.6730
- Window 1: Acc 41.67%, Base 55.83%, Edge **-0.1417**, Brier 0.2804, LogLoss 0.7592
- Window 2: Acc 60.00%, Base 55.83%, Edge **+0.0417**, Brier 0.2575, LogLoss 0.7117
- Window 3: Acc 37.50%, Base 66.67%, Edge **-0.2917**, Brier 0.2947, LogLoss 0.7903
- **Mean Accuracy:** 50.8333% | **Mean Edge:** **-0.089583** | **Median Edge:** **-0.054167** | **Mean Log Loss:** 0.733561

#### 3. TorchMLP / feat-v1 (`exp-e7014f0467`)
- Window 0: Acc 62.50%, Base 60.83%, Edge **+0.0167**, Brier 0.2473, LogLoss 0.6878
- Window 1: Acc 47.50%, Base 55.83%, Edge **-0.0833**, Brier 0.2522, LogLoss 0.6976
- Window 2: Acc 53.33%, Base 55.83%, Edge **-0.0250**, Brier 0.2505, LogLoss 0.6941
- Window 3: Acc 30.00%, Base 66.67%, Edge **-0.3667**, Brier 0.2601, LogLoss 0.7135
- **Mean Accuracy:** 48.3333% | **Mean Edge:** **-0.114583** | **Median Edge:** **-0.054167** | **Mean Log Loss:** 0.698261

#### 4. TorchMLP / feat-v2 (`exp-23c331d5be`)
- Window 0: Acc 64.17%, Base 60.83%, Edge **+0.0333**, Brier 0.2433, LogLoss 0.6797
- Window 1: Acc 44.17%, Base 55.83%, Edge **-0.1167**, Brier 0.2589, LogLoss 0.7111
- Window 2: Acc 56.67%, Base 55.83%, Edge **+0.0083**, Brier 0.2438, LogLoss 0.6807
- Window 3: Acc 34.17%, Base 66.67%, Edge **-0.3250**, Brier 0.2642, LogLoss 0.7216
- **Mean Accuracy:** 49.7917% | **Mean Edge:** **-0.100000** | **Median Edge:** **-0.054167** | **Mean Log Loss:** 0.698271

---

## 6. Governance Gates & Discrepancy Root Cause Analysis

### Tracing the Defect in Code

1. **Gate Configuration Divergence:**
   In standard training supervised by the CLI or TUI (`services-python/aurix_ai/cli.py:364-380`), gates are constructed via `_load_gates()`:
   ```python
   gates = {
       "policy_version": str(policy.get("version", "unknown")),
       "min_oos_edge_vs_baseline": float(auto.get("min_oos_edge_vs_baseline", 0.01)),
       "max_backtest_drawdown_pct": float(auto.get("max_backtest_drawdown_pct", 10.0)),
       "walkforward": dict(auto.get("walkforward", {}) or {}),
       "stress": dict(auto.get("stress", {}) or {})
   }
   ```
   However, in `services-python/aurix_ai/evaluate_matrix.py` (lines 193-197), the execution runner passed a manual dictionary:
   ```python
   gates = {
       "min_oos_edge_vs_baseline": 0.01,
       "max_backtest_drawdown_pct": 10.0,
       "policy_version": "v1.0",
   }
   ```
   `"walkforward"` and `"stress"` were completely omitted.

2. **Scheduler Gate Execution Logic:**
   In `services-python/aurix_ai/orchestrate.py` (lines 582-589):
   ```python
   wf_ok, st_ok = True, True
   if bt_ok and bars_path and os.path.exists(bars_path):
       if wf_cfg.get("enabled", False):
           wf_ok = self._extended_gate(eid, edir, bars_path, "walkforward", wf_cfg, decision)
       if wf_ok and st_cfg.get("enabled", False):
           st_ok = self._extended_gate(eid, edir, bars_path, "stress", st_cfg, decision)
   ```
   Because `wf_cfg` defaulted to `{}`:
   - `wf_cfg.get("enabled", False)` evaluated to `False`.
   - `_extended_gate()` was never called.
   - `wf_ok` and `st_ok` remained `True` by default.

3. **Flawed Promotion String:**
   In `services-python/aurix_ai/orchestrate.py` (lines 596-599):
   ```python
   if mreg.models.get(model_id, {}).get("state") != "VALIDATED":
       mreg.promote(model_id, "VALIDATED", "orchestrator",
                    f"oos edge {edge:.4f} >= {min_edge}; backtest+wf+stress ok")
   self.reg.transition(eid, "VALIDATED", f"edge={edge:.4f} backtest+wf+stress ok")
   ```
   The promotion reason string unconditionally hardcoded `backtest+wf+stress ok`, even when walkforward and stress gates were not enabled or run.

4. **Counterfactual Verdict:**
   If the full governance policy from `config/ai-policy.v1.yaml` had been passed, or if ML walk-forward CV had been required to show non-negative edge:
   - All four models failed walk-forward evaluation (mean edges $-0.0917$ to $-0.1146$).
   - Both `exp-bd0e57cb0d` and `exp-e7014f0467` would have received `REJECTED`.

---

## 7. Artifact & Registry Verification

### Artifact Hash Audit

| Experiment ID | Cell Description | Manifest SHA-256 | Disk `final/artifact.joblib` SHA-256 | Hash Match |
| :--- | :--- | :--- | :--- | :--- |
| `exp-bd0e57cb0d` | LogReg / feat-v1 | `c339131453d79ce11bf07fa6c9a2c510f1dd7565c2146927575124f150bcbd79` | `c339131453d79ce11bf07fa6c9a2c510f1dd7565c2146927575124f150bcbd79` | **MATCH** |
| `exp-5032fc2873` | LogReg / feat-v2 | `c4a4128f2b7c10325d4b60ce1691c42e814be5ad48eb16cae4c236238d2f8e41` | `c4a4128f2b7c10325d4b60ce1691c42e814be5ad48eb16cae4c236238d2f8e41` | **MATCH** |
| `exp-e7014f0467` | TorchMLP / feat-v1 | `03909b3ffdffb8bd44c8fe99dfdd345d531b2963046e15efea66e2a9404c2d48` | `03909b3ffdffb8bd44c8fe99dfdd345d531b2963046e15efea66e2a9404c2d48` | **MATCH** |
| `exp-23c331d5be` | TorchMLP / feat-v2 | `a83f4277dbe2b482885c9dcec9f582063f26b27783cd1b847434aecdc096526a` | `a83f4277dbe2b482885c9dcec9f582063f26b27783cd1b847434aecdc096526a` | **MATCH** |

### Registry State Audit
- **`data/runs/registry.json`:**
  - `exp-bd0e57cb0d`: `status = VALIDATED`
  - `exp-5032fc2873`: `status = REJECTED`
  - `exp-e7014f0467`: `status = VALIDATED`
  - `exp-23c331d5be`: `status = REJECTED`
- **`data/runs/model-registry.json`:**
  - `aurix-marketml-exp-bd0e57cb0d`: `state = VALIDATED`, `artifact_sha256 = c339131...`
  - `aurix-marketml-exp-e7014f0467`: `state = VALIDATED`, `artifact_sha256 = 03909b3...`

---

## 8. Model Comparison: feat-v1 vs feat-v2 & LogReg vs MLP

1. **`feat-v1` vs `feat-v2`:**
   - On the canonical holdout set, `feat-v2` degraded accuracy for both models:
     - LogReg: dropped from 54.51% (`feat-v1`) to 48.26% (`feat-v2`).
     - TorchMLP: dropped from 53.12% (`feat-v1`) to 50.35% (`feat-v2`).
   - In walk-forward cross validation, `feat-v2` exhibited severe negative edge across multiple windows, offering no demonstrable improvement over `feat-v1`.
2. **`TorchMLP` vs `LogRegLBFGS`:**
   - `TorchMLP` showed tighter logit distributions (max $|z| \approx 24$ vs $43$) and slightly better calibration (lower peak cross-entropy on outliers), resulting in lower overall log loss (2.65 vs 4.08).
   - However, in terms of classification accuracy and walk-forward edge, `TorchMLP` did not outperform `LogRegLBFGS`.
   - Both models suffered catastrophic performance degradation in Window 3 of walk-forward validation (30-37% accuracy against a 66.7% majority baseline).

---

## 9. Recommendations & Governance Hardening

To harden the pipeline against configuration divergence and miscalibrated probabilities in subsequent milestones:

1. **Enforce Canonical Gate Loading:**
   Eliminate ad-hoc `gates` dictionaries in scripts. Require all evaluation runners to invoke `_load_gates()` from `cli.py` or directly parse `config/ai-policy.v1.yaml`.
2. **Accurate Governance Reason Formatting:**
   Update `Scheduler.govern()` to dynamically construct its promotion reason string based on actual gate execution:
   ```python
   wf_status = "wf ok" if wf_cfg.get("enabled") else "wf skipped"
   st_status = "stress ok" if st_cfg.get("enabled") else "stress skipped"
   ```
3. **Harmonize ML Walk-Forward CV with Backtest Gates:**
   Incorporate ML walk-forward cross-validation (`walkforward_cv.json`) as a first-class gate in `Scheduler.govern()`, requiring `mean_edge >= 0.0` or `median_edge >= 0.0`.
4. **Probability Calibration Layer:**
   Before computing log loss on holdout sets, apply a calibration transform (e.g. Platt scaling / temperature scaling fitted on validation data) or clip logits before sigmoid to prevent outlier penalties from overwhelming aggregate loss metrics.
