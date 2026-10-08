# Automated Training (orchestrator)

Local-first experiment automation over the existing `run_training()` engine.
No new training framework, no services, no parallelism (max 1 heavy job).

## Start

```cmd
AURIX> aurix train
```

That is the only command needed. It requires no dataset/run/epoch arguments:
it submits default experiments (if none active), starts the detached
supervisor, prints a status line, and returns — workers continue independently.
The supervisor loop (`auto-supervise`) runs `auto-cycle` repeatedly:
queue → train → evaluate → backtest → govern.

## Status / stop

```cmd
AURIX> aurix train status
AURIX> aurix train stop
```

`status` prints a concise block (`Training: RUNNING/STOPPED/IDLE`,
experiment, worker pid, epoch x/y, checkpoint, elapsed, next stage) or
`IDLE` with `No active AURIX training job.` `stop` halts the supervisor at
once (no new work), waits for RUNNING workers to exit naturally so their
per-epoch checkpoints stay valid, marks experiments `STOPPED`, and persists
the stop event. Nothing is deleted; no unrelated process is touched. A later
`aurix train` resumes STOPPED experiments from preserved checkpoints.
Starting twice is safe: a repeat start reuses the live supervisor instead of
spawning a duplicate.

## Background execution (no extra windows)

Supervisor and workers run as hidden background processes
(`DETACHED_PROCESS` + own process group + `CREATE_NO_WINDOW`): one CMD window
stays open, nothing else pops up, and independence is preserved.

## Manual inspection (optional)

From `services-python/` with `../.venv` python, `auto-status` shows state,
elapsed time, epoch, checkpoint, worker pid, next stage, and last result.
Nobody needs to hand-run train/evaluate/resume/backtest.

## Protection of existing runs

Run directories are immutable historical state: the scheduler never deletes,
overwrites, truncates, reuses, or cleans them (regression-tested, including a
static scan for recursive-delete patterns). Test/verification cleanup is only
ever allowed inside an isolated temporary root created by the current test
(`assert_safe_cleanup` enforces this; production `data/runs`, `data/datasets`,
`data/processed` always raise). Prior incident (accidental `data/runs`
deletion during manual verification) is documented here so it is not repeated:
never run recursive deletes against the training roots.

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
