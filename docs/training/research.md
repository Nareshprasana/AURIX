# Autonomous Research Agent (Phase 1)

Deterministic, outcome-driven experiment planning over existing infrastructure
(`services-python/aurix_ai/research.py`). No LLM required; no new training,
registry, knowledge, or broker systems.

## Cycle

`research-cycle [--runs DIR] [--datasets DIR] [--llm-json F] [--dry-run]`:

1. `read_outcomes` — terminal/evaluated experiments with their manifests,
   eval, governance, and backtest records. Live work is never an outcome.
2. `classify_outcome` — 8 classes. Infra problems are never model verdicts;
   poor valid numbers are never infra errors.
3. Conclusions persist as `OBSERVATION` records in `research.jsonl`
   (same shape as `knowledge_refs.jsonl`; import-ready for the TS knowledge
   service, which does not yet ingest them — P2).
4. `derive_questions` — deterministic rules (baseline → adjustment →
   reliability → budget → exploration), deduplicated by content hash.
5. `propose_experiment` — supported space only
   (`sgd-logloss`, `feat-v1`/`label-v1`, known hyperparameters, approved
   dataset roots, budgeted epochs). Seeds derive from question content.
6. `validate_proposal` — schema, policy, dataset loadability, unsupported
   values, fabricated references, duplicate and already-REJECTED
   fingerprints all rejected.
7. Submit via the existing `ExperimentRegistry` (supervisor executes).
   Budgets: per-cycle and total caps; resubmits refused by fingerprint.

`--dry-run` plans without submitting. `--llm-json` accepts an LLM proposal
through the identical validation gate; malformed output is recorded and the
deterministic path continues.

## Records

Question (`rq-*`), hypothesis (`hyp-*`, with expectation + falsification),
conclusion (outcome class, reason, edge, evidence refs) — all content-hashed,
append-only, restart-safe. Reprocessing never duplicates (IDs stable).

## Bounds & safety

Per-cycle cap, total experiment cap, no terminal resubmission, no auto-retry
of REJECTED verdicts, no promotion path (module never imports the model
registry), no broker surface, stop/restart safe via existing scheduler
semantics. Research mode never touches trade execution.

## Limits (tracked, not solved here)

- TS knowledge-service ingestion of research records: P2.
- Walk-forward/stress gates, Qwen wiring, eligibility refresh, local API,
  live research connectors, model convergence: other P1s per
  `docs/audit/core-backend-gap-plan.md`.
