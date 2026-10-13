# AURIX Master Spec — Proposed Reconstruction v0.2 (APPROVED WITH AMENDMENTS)

Status: APPROVED WITH AMENDMENTS per Phase-4 user authorization (2026-10-13,
baseline `69a9251`). NOT fully authoritative: U2 (holiday list) and U3 (ISIN
source) remain without vendored artifacts, and U5/U6/U10 remain deferred —
see UNRESOLVED items below. Requirement IDs (R1–R15, U1–U10) and traceability
are preserved from v0.1; only approval status and the three recorded
amendments changed. The standalone Master Spec v1.0 is still not in the
repository; §-level citations remain per `docs/architecture.md` v1.0.1.

Version history:
- v0.1 (DRAFT, NOT APPROVED): initial reconstruction for review.
- v0.2 (APPROVED WITH AMENDMENTS, 2026-10-13): records the three approved
  amendments — (1) R11 thresholds: PROVISIONAL → APPROVED promotion floors
  per U8 with mandatory re-calibration trigger; (2) R7 connector scope:
  confirmed as the decided intake-only cut per U7; (3) Laya role: recorded as
  deferred per U6. No R-text altered; unresolved requirements kept explicit.

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
Connector scope is a DECIDED cut per U7 (upheld Phase 4): intake-only;
any future live connector needs an approved source, license, and ToS review.

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
never profitability. Threshold values are APPROVED promotion floors per U8
(Phase 4, 2026-10-13), not spec quality claims:
`min_oos_edge_vs_baseline: 0.01`, `min_median_sharpe: 0.0` (floor),
`max_backtest_drawdown_pct: 10.0`. The 0.0 Sharpe floor is a non-negativity
sanity check on median out-of-window risk-adjusted return, NOT evidence of
profitability. Mandatory re-calibration trigger: once a real VALIDATED
candidate exists, these floors must be re-approved against observed data;
thresholds are never tuned on the test set. UNSPECIFIED (no value invented):
the minimum evaluated-window count for a statistically meaningful median
Sharpe; the engine enforces only a non-vacuity floor (windows ≥ 1).

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
- U1. Regulatory-intel full worker: APPROVED Phase 4 as curated seed file
  (`config/regulatory-seed.v1.json`, sources + `as_of` recorded, refresh tied
  to releases); full worker remains Phase 3+ scope, no scraping.
- U2. Authoritative NSE holiday calendar list: APPROVED in principle, BLOCKED
  on acquisition — no NSE-published list could be verified this phase (NSE
  publication page unreachable); dates must not be invented. Mechanics accept
  explicit lists (tested). Re-entry: vendor the NSE-published list per year
  with source URL + year version recorded.
- U3. ISIN-anchored instrument identity + delisted/survivorship source:
  DEFERRED — eod2 license review FAILED (no license file in `eod2_data`;
  data sourced from NSE reports with no grant; EOD2 project code is GPL-3.0,
  which licenses code, not the NSE-sourced data). No ISIN join adopted;
  existing eod2 CSV use stays local-only, no expansion. Never invent mappings.
- U4. Adjusted-price default policy (raw vs eod2-adjusted): APPROVED Phase 4 —
  eod2-adjusted is the training-data default; raw retained for audit archives
  with provenance; re-baselining creates new traceable results, never rewrites
  history. Residual: eod2 dividends unadjusted.
- U5. `.akpkg` encryption: DEFERRED to Phase 11 (unchanged).
- U6. Laya role: DEFERRED with re-entry bar unchanged (named task + baseline
  + 4GB coexistence proof); package stays vendored but unwired.
- U7. Live research connectors: DECIDED intake-only cut, UPHELD Phase 4.
- U8. Walk-forward/stress threshold values (see R11): APPROVED as promotion
  floors with re-calibration trigger (Phase 4).
- U9. Frontend authorization model: APPROVED bearer-on-loopback for the
  local-only initial frontend (Phase 4); revisit only if scope leaves localhost.
- U10. Production model existence: DEFERRED — real-market retraining remains
  a separate future operation requiring explicit authorization; no VALIDATED
  model exists.
