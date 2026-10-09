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

## Authoritative state (`auto-state`)

`TrainingState` (`services-python/aurix_ai/state.py`) is the single source of
truth for the terminal UI, `auto-status`, `aurix train status`, and the future
web frontend — all read the same persisted supervisor/worker state, none keeps
its own. Fields: state, experiment_id, dataset_id, stage, worker
(name/pid/state), epoch/total_epochs, loss, validation_loss, progress,
started_at, updated_at, elapsed_seconds, heartbeat_age_seconds, checkpoint,
last_event, health (IDLE/STARTING/RUNNING/STALLED/FAILED/STOPPING/STOPPED/
COMPLETED), error, stdout/stderr references (+ log tail), backtest run record,
recovery_state, per-stage pipeline (dataset/training/evaluation/backtest/
governance/registry as PENDING/RUNNING/PASSED/FAILED/BLOCKED), code_version.
No broker credentials, no risk/execution data, no training logic inside.

## Events (single mechanism: `events.jsonl` per run)

Legacy UPPER_SNAKE names (`TRAINING_STARTED`, `CHECKPOINT_CREATED`,
`TRAINING_COMPLETED`, `TRAINING_FAILED`, `EVALUATION_*`, `BACKTEST_*`,
`GOVERNANCE_REJECTED`, `MODEL_VALIDATED`, `EXPERIMENT_QUEUED`) plus new dotted
names (`training.stalled`, `training.stopped`, `training.stop_requested`,
`training.failed`). Same file, same schema (timestamp, type, experiment ID,
worker PID, status/error, checkpoint refs) — one system, documented eras.
Stall detection runs every scheduler cycle (stale heartbeat, dead worker, no
epoch progress) and records `training.stalled` once per epoch; nothing is
killed. Subprocess runs persist full records (`backtest-run.json`: stdout —
or explicit `EMPTY` — stderr, exit code, start/end times, stage, experiment,
worker PID); empty diagnostics are recorded, never discarded.

## Future frontend (not built)

```text
                 AURIX Supervisor
                       │
                Training State (auto-state JSON)
                       │
             ┌─────────┴─────────┐
             │                   │
       Terminal UI          Web Frontend (control/visualization only)
             │                   │
             └─────────┬─────────┘
                       │
              Training Worker
```

Minimal backend mapping (no new server, no new database):

```text
GET  training status      → auto-state
GET  training events/logs → auto-logs
POST start training       → auto-train
POST stop training        → auto-stop
GET  current experiment   → auto-state.experiment_id + stage
GET  checkpoint state     → auto-state.checkpoint + heartbeat
GET  training history     → registry.json + per-run events
```

The frontend must remain a control/visualization layer only: no training,
risk, promotion, broker, checkpoint, or governance logic. Planned views:
training (experiment/dataset/worker/PID/epochs/losses/checkpoint/elapsed),
pipeline (per-stage PENDING/RUNNING/PASSED/FAILED/BLOCKED), live logs
(timestamp/stage/event/message/error/stdout/stderr), failure panel (stage,
worker, exit code, exception, stdout/stderr, checkpoint, recovery), history
(past experiments + outcomes). Isolation invariants hold: UI and worker never
touch broker credentials or risk/execution controls; training ≠ live trading.
