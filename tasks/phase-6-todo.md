# AURIX Phase 6 TODO

From `tasks/phase-6-plan.md`. Phases 1–5 suites (267 TS + 13 py) must stay green.

## Design
- [x] `tasks/phase-6-plan.md`
- [x] `tasks/phase-6-todo.md` (this file)

## Strategy package (`packages/strategy`, pure TS)
- [x] Contracts: definition/lifecycle/hypothesis/signal/regime/cost/slippage/liquidity/calendar/metrics/evaluation/experiment/dataset
- [x] Families: sma-cross, donchian-breakout, zscore-meanreversion, roc-momentum, event-reaction (+ interface)
- [x] Indicators (SMA/ROC/stdev/Donchian/zscore), regime classifier + applicability
- [x] Cost/slippage/liquidity/calendar pure logic + metrics + benchmark compare

## Backtest app (`apps/backtest`)
- [x] Versioned datasets + PIT filtering + corporate-action adjustments (recorded)
- [x] Event loop (1-bar execution delay), hypothetical orders, fill simulation, accounting
- [x] OOS split, walk-forward windows, stress scenarios, parameter sweep + robustness
- [x] Overfitting guards (lineage, duplicate-spec reuse, sweep-size surfacing)
- [x] Evaluation framework + degradation detection
- [x] Experiment + strategy registries (knowledge-backed) + lifecycle transitions
- [x] Memory-first lookup + strategy-memory records + knowledge commits (non-FACT)
- [x] Failure states (no performance on missing/invalid data)

## Python parity
- [x] Lifecycle + evaluation label mirrors + tests

## Proof script
- [x] `scripts/verify-strategy.mjs` (§44 workflow + reproducibility + §45 impossibility)

## Tests (§43)
- [x] Units, correctness (look-ahead traps), OOS, walk-forward, stress, memory, security

## Audit + verify + commit
- [x] `pnpm test`, `pytest`, `typecheck`, `lint`, `build`, all seven verify scripts
- [x] `docs/audits/phase-6-audit.md` (25 areas + F-P6-1…13, severity)
- [x] Fix CRITICAL/HIGH (MEDIUM unless non-blocking); focused commits; final report (no Phase 7)
