# Automated Training (orchestrator)

Local-first experiment automation over the existing `run_training()` engine.
No new training framework, no services, no parallelism (max 1 heavy job).

## Start / status

From `services-python/` with `../.venv` python:

```powershell
../.venv/Scripts/python -c "from aurix_ai.cli import main; main(['auto-submit','--def-json','<exp.json>'])"
../.venv/Scripts/python -c "from aurix_ai.cli import main; main(['auto-cycle'])"   # queue→train→evaluate→govern
../.venv/Scripts/python -c "from aurix_ai.cli import main; main(['auto-status'])"
```

Hands-free mode: `auto-start` spawns a detached local supervisor loop
(`auto-supervise --interval 30`, pid file `data/runs/supervisor.pid`).
This is a plain detached process, NOT a Windows service.

Experiment definition JSON: `{dataset_dir, dataset_version?, model_type,
hyperparameters, seed, epochs, device?, backtest_bars?, parent_experiment?}`.
IDs are deterministic content hashes — resubmits are refused, run dirs are
never reused.

## Lifecycle

`QUEUED → RUNNING → COMPLETED → EVALUATED → VALIDATED | REJECTED`
(`FAILED`/`CANCELLED` terminal). Workers are independent processes
(`auto-worker`) writing only `data/runs/<exp-id>/`, heartbeating every 5 s
(`heartbeat.json`: pid/epoch/checkpoint/ts). The scheduler never deletes run
directories — recovery is resume-from-checkpoint or clean restart, both recorded.

A freshly spawned worker gets a 120 s heartbeat grace period so the scheduler
can never double-spawn a duplicate worker (regression-tested).

## Gates (deterministic, `config/ai-policy.v1.yaml → automation`)

1. Dataset loads (`load_dataset`, checksum-verified) or the experiment FAILS.
2. OOS evaluation after training (accuracy/precision/recall/baseline persisted).
3. Backtest gate via `scripts/backtest-gate.mjs` (existing engine, cost-aware;
   missing bars ⇒ gate missing ⇒ no promotion). Accuracy ≠ profitability.
4. Governance: edge over baseline ≥ `min_oos_edge_vs_baseline` (0.01) AND
   backtest ok AND drawdown ≤ cap ⇒ model registered CANDIDATE → promoted
   **VALIDATED** only. Otherwise REJECTED. PAPER and beyond stay operator-only.
   Walk-forward/stress: not yet automated — recorded as missing gates, and
   promotion stops at VALIDATED.

LLM (Qwen) may only supply a validated JSON proposal (`auto-suggest
--llm-json`); deterministic seed-variants work offline. Laya is not in the
numerical loop. Every run appends `events.jsonl` (QUEUED/STARTED/CHECKPOINT/
RESUMED/COMPLETED/FAILED/EVALUATED/BACKTEST/GOVERNANCE/VALIDATED) and an
experiment-result OBSERVATION to `knowledge_refs.jsonl`.

## Resource policy

`max_concurrent_training: 1`, CPU selected via existing resource detection
(torch CPU-only build; GPU presence never implies CUDA). Stale heartbeats
(>600 s) or dead workers trigger checkpoint resume, never blind restart.
