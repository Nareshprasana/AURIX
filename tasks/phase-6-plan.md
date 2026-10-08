# AURIX Phase 6 Plan — Strategy Intelligence & Backtesting

Baseline: Phases 1–5 + cumulative audit (PASS). Additive only. No portfolio
optimization, capital allocation, broker execution, live trading, or production
training. Output is validated strategy intelligence, never orders.

Principle: Research ≠ Strategy ≠ Backtest ≠ Validated ≠ Live. Backtests are evidence,
not proof. No successful backtest auto-activates anything.

## 1. Placement (new code, reuse everywhere)

- `packages/strategy` — pure TS, zero node imports: strategy/hypothesis/signal/regime
  contracts, lifecycle states, 4+ deterministic declarative families (sma-cross,
  donchian-breakout, zscore-meanreversion, roc-momentum), indicators, regime
  classifier + applicability, cost model, slippage model, liquidity guards, trading
  calendar, performance metrics, benchmark compare. No eval/exec; conditions are data.
- `apps/backtest` — engine + methodology (node:sqlite only via existing adapters):
  versioned datasets (hash + range + adjustments recorded), point-in-time event loop
  (signals at close t execute at next open t+1), hypothetical orders (distinct type,
  never BrokerPort), fill simulation, position accounting, OOS split, walk-forward
  windows, stress scenarios, parameter sweep + robustness analysis, overfitting guards
  (lineage, duplicate-experiment reuse), evaluation framework (REJECTED/WEAK/PROMISING/
  ROBUST/DEGRADED/INSUFFICIENT_DATA/INVALID), experiment + strategy registries on
  knowledge Experiment/Strategy nodes + strategy-memory records, memory-first lookup
  (identical spec → REUSE; changed inputs → rerun), knowledge commits as
  OBSERVATION/EXPERIMENT-RESULT/INFERENCE/HYPOTHESIS (never FACT).
- `services-python`: tiny parity (lifecycle states, evaluation labels) + tests.
- `scripts/verify-strategy.mjs`: real-SQLite §44 workflow + reproducibility (run twice,
  equivalent persisted results) + §45 impossibility proofs.

## 2. Strategy domain model (persisted, reproducible)

`StrategyDefinition {id, version, name, description, family, scope {markets, segments,
timeframes, universe}, entry/exit (structured conditions), sizing {type:'fixed-qty'|
'fixed-notional', qty|notional, max_notional, max_adv_pct, max_participation},
signal spec, required_observations/data/events, assumptions, cost_model,
slippage_model, liquidity {min_value, min_volume, max_spread_bps}, regimes
{supported, preferred, blocked}, params + bounds, created_at, author, provenance,
evidence_refs, status, parent}`. Lifecycle: HYPOTHESIS→CANDIDATE→BACKTESTED→
OOS_VALIDATED→WALK_FORWARD_VALIDATED→STRESS_TESTED→PAPER_ELIGIBLE (terminal in Phase 6;
APPROVED recorded but unwired), plus REJECTED/DEGRADED/RETIRED. Transitions validated;
history via node versions. Reproducible from definition + dataset + code versions.

## 3. Hypothesis layer (research → structure, never raw LLM → logic)

`StrategyHypothesis {id, research_inputs, observations, mechanism, target_regime,
expected_signal/behavior, falsification, assumptions, evidence, confidence,
provenance}`. Builder validates required fields; LLM text (via injected interpreter,
gateway outside) may propose wording, but strategy definitions are constructed only by
validated builders from structured hypotheses. Same hypothesis + params → same
definition (tested).

## 4. Signals + regime (deterministic, NO_SIGNAL valid)

`Signal {strategy_id/version, instrument_id, ts, type LONG|SHORT|EXIT|HOLD|NO_SIGNAL|
INVALID, direction, strength, horizon, ref_price, observations, data_version, params,
evidence, confidence, regime, generated_at}`. Regime classifier (trend/volatility/
abnormal) is vendor-neutral; strategies declare supported/preferred/blocked regimes;
`checkApplicability` returns APPLICABLE|NOT_APPLICABLE+reason, and generation
short-circuits to NO_SIGNAL (never forced). No BUY/SELL broker commands anywhere.

## 5. Backtest engine (simulation only, no look-ahead)

Per-bar loop over pit-filtered data (`ts <= t` strictly; fundamentals by publication;
corporate actions by ex-date with recorded adjustment method/version, double-adjust
guarded by applied-action ids; missing PIT info → limitation flagged, never assumed).
Signal at close t → hypothetical order → fill at next session open (1-bar delay) with
cost + slippage; partial fills when participation-capped; exits always allowed.
Position accounting: cash/positions/avg-cost/realized/unrealized/gross/net/turnover/
fees/slippage/drawdown (simulation only). Failure states:
QUEUED/RUNNING/COMPLETED/PARTIAL/INSUFFICIENT_DATA/DATA_QUARANTINED/INVALID/FAILED/
CANCELLED — missing/invalid data never yields performance.

## 6. Costs, slippage, liquidity, calendar (config-driven, broker-neutral)

CostModel {brokerage_bps, exchange_bps, taxes_bps, min_cost, per_side} — no broker fee
schedule hardcoded. Slippage fixed-bps + liquidity-aware
(base + spread/2 + impact*√(orderValue/advValue), spread assumed only with recorded
assumption). Liquidity guards (min value/volume, participation, ADV share, spread cap);
UNKNOWN liquidity blocks entries (never assumes LIQUID). TradingCalendar
(sessions/holidays/weekends/boundaries) vendor-neutral; non-session days never traded.

## 7. Metrics, benchmark, OOS, walk-forward, stress, robustness

Metrics: total return, CAGR, volatility, maxDD (+duration), downside dev, Sharpe/Sortino
(rf=0 stated), Calmar, trades, win rate, avg win/loss, profit factor, turnover, avg hold,
worst day/trade, loss streak, concentration. Benchmarks: buy-and-hold same universe,
zero baseline; excess return + risk difference. OOS: date split, fixed params, no tuning
on OOS (sweep API accepts in-sample only — enforced). Walk-forward: generated windows
with disjoint test ranges, per-window persistence, aggregation after. Stress: cost/
slippage/spread/liquidity/volatility-shock/gap/delay/missing-data/regime scenarios vs
base. Sweep: grid over bounds → stable-region/cliff analysis. Overfitting: lineage
(strategy+params+dataset+range+models+code versions), sweep-size recorded and surfaced
in evaluation, duplicate-spec reuse instead of rerun, best-of-N flagged without OOS.

## 8. Evaluation + registries + memory/knowledge integration

`evaluate(result, context)` → REJECTED/WEAK/PROMISING/ROBUST/DEGRADED/
INSUFFICIENT_DATA/INVALID from return/risk/drawdown/robustness/OOS/WF/cost-sensitivity/
liquidity/parameter-sensitivity/sample/regime rules (documented thresholds, no
single-metric approval; positive returns alone never approve). Degradation: OOS Sharpe <
50% of IS Sharpe (heuristic, labeled). Registries persist definitions/versions/
hypotheses/experiments/evaluations/evidence/performance/lifecycle/degradation/parentage
as knowledge nodes (Experiment/Strategy kinds) + strategy-memory records (tested, why,
datasets, params, outcomes, failures, regimes, robustness, degradation, rejects) —
surviving model swap/restart/sync via existing semantics. Knowledge commits as
OBSERVATION/INFERENCE/HYPOTHESIS with provenance; backtest results never FACT.

## 9. Safety (absolute boundary)

Hypothetical orders are a distinct type incompatible with BrokerPort; engine imports no
broker/execution/risk-live/model-gateway/training code (lint + scan tests); strategies
are declarative data (no eval/exec/shell/fs in strategy code — scanned); LLM reaches
only hypothesis wording via injected interpreter; research↛execution impossibility
proven in verification (import scan + sim-order count zero + type incompatibility).
Training isolation untouched (sweeps are bounded experiments, artifact-separated).

## 10. Tests (§43) + gates

Units (definitions/signals/indicators/accounting/costs/slippage/calendars/metrics/regime/
sensitivity), correctness (look-ahead traps, fills/cash/P&L/fees/slippage/drawdown),
OOS (separation/leakage), walk-forward (windows/aggregation), stress (5 shocks),
memory (reuse/invalidation/duplicate), security (imports/secrets/shell/eval). Then
`pnpm test`, `pytest`, `typecheck`, `lint` (new boundary rules), `build`, all six
verify scripts, `docs/audits/phase-6-audit.md` (25 areas + F-P6-1…13 sweep), fix
CRITICAL/HIGH (MEDIUM unless proven non-blocking), focused commits, final report.
No Phase 7.
