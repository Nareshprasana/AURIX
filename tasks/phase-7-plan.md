# AURIX Phase 7 Plan — Portfolio Construction, Capital Allocation & Risk Integration

Baseline: Phases 1–6 + audits (all PASS). Additive only. No broker execution, live
trading, production training, or Phase 8. Output is a risk-controlled hypothetical
portfolio decision — never an order.

Principle: strategy ("attractive?") ≠ allocation ("how much?") ≠ risk ("allowed?").
Risk always wins; UNKNOWN never becomes ALLOW; NO_TRADE is success.

## 1. Placement (new code, reuse everywhere)

- `packages/portfolio` — pure TS, zero node imports: domain contracts (Portfolio,
  Position, Candidate, CapitalState, RiskDecision, RebalanceIntent, PortfolioDecision,
  snapshots), capital model, six deterministic allocators (equal, signal, risk,
  volatility-adjusted, confidence, hybrid) + bounded outputs, exposure math
  (gross/net/long/short), concentration (top-5/10, HHI, sector/asset-class),
  correlation (matrix, cluster exposure, unknown→conservative penalty), sector
  resolution via knowledge entity ids (unknown bucket, never silent zero), liquidity
  (ADV participation, liquidation estimate, spread), volatility + risk contribution,
  five position-sizing methods, drawdown/daily-loss state machine
  (NORMAL/CAUTION/RESTRICTED/HALTED), abnormal-market handling, turnover control,
  rebalance engine (intents BUY/SELL/REDUCE/INCREASE/HOLD/NO_CHANGE/BLOCKED +
  cost estimate via strategy cost model), mark-to-market, decision records.
- Risk evaluation lives in `packages/portfolio/src/risk.ts` reusing the SAME
  `RiskPolicy` limits as Phase 1 (2% position, 60%/25% gross, 20% sector, 1.0
  leverage, 50% margin, 1.5% daily loss, 8% drawdown, 5% ADV, 50bps spread, 40%
  top-5, 50% abnormal haircut) plus `config/portfolio-policy.v1.yaml` for
  simulation-only extras (drawdown-state bands, turnover budget, unknown-sector cap,
  correlation cluster cap). Decisions ALLOW/REDUCE/REJECT/UNKNOWN with rule-level
  detail; data-quality QUARANTINED/STALE/UNKNOWN/MISSING on critical inputs forces
  UNKNOWN (fail-safe). `packages/risk-engine` untouched.
- `apps/portfolio-service` — pipeline only (no broker): candidates ← signals,
  construct → allocate → risk-evaluate → rebalance vs current → decision → persist
  (knowledge Portfolio nodes + portfolio-memory records + snapshots). Deterministic
  decision ids (content hash → idempotent reruns, no duplicate state).
- `services-python`: tiny parity (decision states, allocator names) + tests.
- `scripts/verify-portfolio.mjs`: real-SQLite §42 loop + §43 proofs + §44
  reproducibility (run twice, identical decisions).

## 2. Capital model (deterministic, reserved-aware)

`CapitalState {total, cash, invested, available, reserved, margin_used, free_margin,
gross, net}` from `CapitalProfile {total, reserved_pct, margin_rule}`. Available =
total − reserved − invested − margin_locked. Nothing assumes full deployability.

## 3. Allocation (explainable, bounded, LLM-free weights)

Each method maps candidates (+volatilities for risk/vol variants, confidences) to
weights with max-position cap applied and remainder handling documented; hybrid =
0.4·signal + 0.3·inverse-vol + 0.2·confidence + 0.1·liquidity (configurable weights in
policy, normalized inputs). Unknown correlation → same-sector/unknown cluster jointly
capped (conservative). No LLM weight input exists in any signature.

## 4. Risk (veto authority, deterministic)

Per-candidate checks (weight, sector, ADV, spread, liquidity, abnormal, data-quality,
strategy authorization, mode) + portfolio checks (gross/net, leverage, margin,
concentration, daily loss, drawdown state, turnover). REDUCE returns capped qty with
the binding rule cited; UNKNOWN on missing inputs blocks downstream (service treats
UNKNOWN as BLOCKED). Abnormal: halve caps or block per policy. Drawdown bands:
NORMAL <4%, CAUTION ≥4%, RESTRICTED ≥6%, HALTED ≥8% or daily-loss breach (configurable,
documented). Risk cannot be overridden: service drops REJECT/UNKNOWN candidates and
applies REDUCE caps before sizing finalization.

## 5. Sizing, rebalance, snapshots, memory, knowledge, events

Sizing (fixed-fraction, volatility-target, risk-budget, max-loss-budget,
liquidity-constrained): explicit inputs, bounded outputs, explanations; final qty =
min across applicable methods and risk caps. Rebalance diffs current vs target with
turnover budget (largest-delta-first cutoff, rest NO_CHANGE + reason) and cost
estimates. Snapshots + decisions persist with full version traces (strategy/signal/
dataset/knowledge/memory/config/risk/allocator/code/timestamp). Portfolio memory
records allocations/rejects/reasons/violations/drawdowns/structures; knowledge
observations with provenance (never FACT). Events invalidate candidates by entity
intersection (scoped, reuse Phase 5 machinery). Strategy attribution
position→strategy→signal→research→evidence; risk attribution per position/sector/
strategy (labeled approximation where exact). Failure states
READY/CALCULATING/COMPLETED/PARTIAL/INSUFFICIENT_DATA/RISK_BLOCKED/
DATA_QUARANTINED/UNKNOWN/FAILED; NO_TRADE on empty/all-rejected.

## 6. Safety (absolute boundary maintained)

Hypothetical intents are a distinct vocabulary (never BrokerPort shapes); engine and
service import no broker/execution/gateway/training code (lint + scan tests); no
secrets; no eval/exec/shell; prompt-injection cannot alter limits/weights/mode
(no LLM in the path at all — allocation/risk are pure functions; tested). Simulated
vs live state strictly separated (no account/broker reads anywhere in Phase 7 code).

## 7. Tests (§41) + gates

Allocation (5 methods + bounded), limits (position/sector/top-5/gross/net/leverage/
margin), liquidity (ADV/spread/missing/stale), correlation (independent/correlated/
unknown), risk states (4 + abnormal), drawdown bands (3), daily loss (2), data quality
(4), events (4 types), rebalance (5 intents + blocked + churn), security (boundary/
bypass/secrets/injection), idempotency, reproducibility, attribution. Then `pnpm test`,
`pytest`, `typecheck`, `lint` (new boundary rules), `build`, all eight verify scripts,
`docs/audits/phase-7-audit.md` (28 areas + F-P7-1…15 sweep), fix CRITICAL/HIGH (MEDIUM
unless proven non-blocking), focused commits, final report. No Phase 8.
