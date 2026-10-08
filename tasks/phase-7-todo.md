# AURIX Phase 7 TODO

From `tasks/phase-7-plan.md`. Phases 1–6 suites (341 TS + 15 py) must stay green.

## Design
- [x] `tasks/phase-7-plan.md`
- [x] `tasks/phase-7-todo.md` (this file)

## Portfolio package (`packages/portfolio`, pure TS)
- [x] Contracts: portfolio/position/candidate/capital/risk-decision/rebalance/snapshot/decision
- [x] Capital model (reserved-aware) + exposure math
- [x] Allocators: equal/signal/risk/volatility/confidence/hybrid (bounded, explainable)
- [x] Concentration/correlation/sector/liquidity/volatility/risk-contribution
- [x] Sizing: fixed-fraction/vol-target/risk-budget/max-loss/liquidity-constrained
- [x] Risk evaluation (same Phase 1 limits + portfolio-policy extras; ALLOW/REDUCE/REJECT/UNKNOWN)
- [x] Drawdown state machine + abnormal handling + data-quality fail-safe
- [x] Rebalance engine (intents + turnover budget + cost estimates) + mark-to-market
- [x] Snapshots + decision records (full version traces)

## Service (`apps/portfolio-service`, pipeline only, no broker)
- [x] Candidates ← signals → construct → allocate → risk → rebalance → decision → persist
- [x] Memory records + knowledge observations + event invalidation (scoped)
- [x] Deterministic decision ids (idempotent reruns), NO_TRADE path, failure states

## Config
- [x] `config/portfolio-policy.v1.yaml` (drawdown bands, turnover, unknown caps, hybrid weights)

## Python parity
- [x] Decision states + allocator names + limit constants mirrors + tests

## Proof script
- [x] `scripts/verify-portfolio.mjs` (§42 loop + §43 proofs + §44 reproducibility)

## Tests (§41)
- [x] Allocation/limits/liquidity/correlation/risk-states/drawdown/daily-loss/quality/events/rebalance/security/idempotency/attribution

## Audit + verify + commit
- [x] `pnpm test`, `pytest`, `typecheck`, `lint`, `build`, all eight verify scripts
- [x] `docs/audits/phase-7-audit.md` (28 areas + F-P7-1…15, severity)
- [x] Fix CRITICAL/HIGH (MEDIUM unless non-blocking); focused commits; final report (no Phase 8)
