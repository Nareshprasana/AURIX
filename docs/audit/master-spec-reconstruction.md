# AURIX Master Spec — Proposed Reconstruction v0.1 (DRAFT, NOT APPROVED)

Status: PROPOSAL for review. The standalone Master Spec v1.0 is not in the
repository; this document reconstructs its requirements from `docs/architecture.md`
v1.0.1 (which cites Master Spec §§), phase plans/audits, and verified behavior.
Nothing here is approved policy. UNRESOLVED items need explicit decisions.
Provisional policy (e.g. governance thresholds) is marked as such and must not
be treated as approved.

Traceability key: [A§x] = architecture section; [P1..P8] = phase audits;
[code] = implementation; [T] = targeted test evidence.

## R1. Local-first single-machine system [A§1,§4]
System runs on one Windows/Linux box with no cloud dependency; trading-critical
paths work offline except market-data fetch, localhost Ollama, and broker APIs.
Evidence: local SQLite/JSONL stores, localhost binds. No K8s/Docker anywhere. [code][T]

## R2. Deterministic risk veto, independent of AI [A§11, am.3]
Risk engine answers ALLOW/REJECT only, never sizes up; no LLM override path.
Evidence: `packages/risk-engine`, gate matrix tests, boundary lint. [P1][T]

## R3. Order Safety Gate on every order path [A§11b, am.3]
Final-payload validation (eligibility LEGAL-only, market state, qty/lot/tick,
notional, duplicates, staleness, strategy/mode authorization) before any broker
contact, with TOCTOU revalidation. [code][T]

## R4. Broker abstraction, sim-only execution [A§12]
Vendor-neutral `BrokerPort`; only `broker-sim` executable; Kite disabled
scaffold; reconciliation treats broker state as authoritative after UNKNOWN.
Live trading unreachable (five independent blocks). [P1][P8][T]

## R5. Modes and promotion gate [A§13, am.5]
RESEARCH/BACKTEST/SHADOW/PAPER/CONTROLLED_LIVE/AUTONOMOUS_LIVE with persisted
promotion; config/env/CLI/LLM can never independently enable live trading.
AUTONOMOUS_LIVE remains DISABLED. [code][T]

## R6. Knowledge platform with provenance [A§7, am.4]
Append-only `knowledge_events`, OBSERVATION/INFERENCE/HYPOTHESIS/FACT labels,
FACT promotion only via corroboration policy, provenance on every commit,
deterministic `.akpkg` export with tamper detection. [P2][T]

## R7. Memory-first research, observations only [A§9]
Specialist agents produce structured observations/conclusions with evidence
refs; never trade decisions, orders, or broker calls. LLM input is optional
and sandboxed (secret scan, MODEL_UNAVAILABLE fallback). [P5][T]

## R8. Strategy/backtest determinism [A§10]
Versioned datasets with point-in-time discipline, no look-ahead, cost/slippage/
liquidity accounting, OOS + walk-forward + stress functions, spec-hash
reproducibility, benchmark comparison. [P6][T]

## R9. Portfolio construction under risk caps [A§10]
Bounded allocation methods, sizing, turnover budgets, exposure/concentration
limits, risk veto binds sizing. [P7][T]

## R10. Training lifecycle integrity [A§14]
Immutable versioned datasets with checksums; causal features; train-only
scaling; chronological splits; real parameter updates; immutable checkpoints
with resume; candidate-locked registry; explicit promotion only. [proof][T]

## R11. Experiment governance [A§14]
OOS edge vs baseline + backtest + walk-forward + stress gates; infra failures
classified FAILED (retryable), poor results REJECTED (terminal); accuracy is
never profitability. Threshold values below are PROVISIONAL policy, not spec:
`min_oos_edge_vs_baseline: 0.01`, `min_median_sharpe: 0.0` (floor),
`max_backtest_drawdown_pct: 10.0`. UNRESOLVED: approve or replace these floors.

## R12. Autonomous research loop [A§14]
Outcome-driven planning (read → question → hypothesize → validate → submit →
classify → persist → reselect) within budgets, deduplicated, restart-safe,
LLM-optional, promotion-free. [impl][T]

## R13. Observability without polling [A§16]
Single TrainingState source for terminal UI, status/logs commands, and future
frontend; persisted events; stall detection; split stdout/stderr records;
hidden background processes; one supervisor, one worker max. [impl][T]

## R14. Security boundaries [A§5.4, §16]
Secret redaction at gateway/knowledge/ledger; broker credentials never in
prompts/context/logs; LLM/research/knowledge/memory cannot reach brokers
(lint + scans); local API requires bearer token on loopback. [T]

## R15. Sync and recovery [A§15]
Opaque-package device transfer with conflict handling; crash→restart→reconcile
for execution, sync, and training supervision. [P3][T]

## UNRESOLVED items (need explicit decisions)
- U1. Regulatory-intel full worker: architecture defers to Phase 3+;Refresh cadence, authoritative NSE source, and rule-tracking scope undecided.
- U2. Authoritative NSE holiday calendar list: mechanics support explicit lists; no approved list vendored (must not invent dates).
- U3. ISIN-anchored instrument identity + delisted/survivorship source: not selected.
- U4. Adjusted-price default policy (raw vs eod2-adjusted): needs approval.
- U5. `.akpkg` encryption: deferred to Phase 11 per code comment; key management undesigned.
- U6. Laya role: advisory integration vs removal from architecture.
- U7. Live research connectors: intake-only cut recorded (`docs/audit/research-connectors-decision.md`); revisit needs sourced, licensed feed.
- U8. Walk-forward/stress threshold values (see R11): provisional.
- U9. Frontend authorization model beyond local token: deferred to frontend phase.
- U10. Production model existence: no VALIDATED model; registry holds CANDIDATEs only.
