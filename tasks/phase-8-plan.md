# AURIX Phase 8 Plan — Execution & Broker Integration (Simulation/Paper Only)

Baseline: Phases 1–7 + audits (all PASS). Additive only. Live submission stays
disabled; AUTONOMOUS_LIVE stays DISABLED; no Phase 9, training, or live trading.
Success = safe uncertainty handling (stop → record → reconcile → resume-if-safe),
not a working live broker call.

Principle: only `Execution Service → Safety Gate → Broker Adapter → Broker` may
reach the broker boundary, and in Phase 8 the only wired adapter is the simulator.
Research/strategy/portfolio/risk/LLM/memory/knowledge can never reach a broker.

## 1. Placement (extend, don't duplicate)

- `packages/execution-interface` — extend (additive): full `BrokerPort`
  (authenticate, account, positions, orders, place/modify/cancel, instrument, quote,
  margin) with generic types; canonical `ExecutionRequest` + `OrderRecord` with the
  15-state lifecycle + legal transition table; idempotency/duplicate policy types;
  reconciliation report types; retry classification; kill-switch types; secret-provider
  interface (adapter receives secrets, never logs/stores them).
- `apps/execution-service` — flesh out from skeleton: planner (portfolio intents →
  requests with risk-decision currency checks), lifecycle engine (validate → gate →
  finalize → submit → track → reconcile), TOCTOU revalidation, timeout→UNKNOWN→
  reconcile (never blind resubmit, never assume fill/reject), partial-fill accounting
  (idempotent fill events), cancel flow with explicit policy (cancel only on operator
  intent or stale/expiry, never blind mass-cancel), reconciliation engine (broker wins
  for broker facts, local intent preserved, discrepancies recorded), restart recovery
  (load ledger → query broker → reconcile → resume only if safe, else NO NEW RISK),
  rate limiter (token bucket) + bounded retry/backoff with classification persisted,
  kill switches (global/strategy/instrument/portfolio/subsystem, deterministic,
  LLM-untouchable), JSONL-backed ledger (append-only persistence + reload) + redacted
  audit trail, `LiveSubmissionGate` (promotion + operator + auth + health + killswitch
  + explicit flag — all false in Phase 8, each independently blocking, tested).
- `apps/brokers/broker-sim` — extend to full interface + deterministic fault
  injection (accept/reject/partial/full/cancel/timeout/duplicate/malformed/outage/
  rate-limit/slippage/fees/delay) + client-tag idempotency support + query surface
  for reconciliation. Same canonical contracts as production (simulation parity).
- `apps/brokers/broker-kite` — stays DISABLED scaffold: conform to the extended
  interface with every method throwing; no HTTP, no SDK, no credentials; document the
  activation checklist (promotion/operator/auth/health/killswitch) without enabling.
- `services-python`: tiny parity (order states, retry classes) + tests.
- `scripts/verify-execution.mjs`: deterministic fixture running §57 loop + all 18
  §58 scenarios + §59 impossibility proofs + §60 repo scan.

## 2. Execution request → order lifecycle (deterministic state machine)

Request carries: ids (request/portfolio/strategy/risk-decision/trace/config),
instrument/side/qty/type/limit/trigger/TIF/notional/horizon, versions, timestamps.
States: CREATED→VALIDATING→{REJECTED | APPROVED→SUBMITTED→{ACKNOWLEDGED→
{PARTIALLY_FILLED}→FILLED | BROKER_REJECTED | UNKNOWN→RECONCILING→RECONCILED} |
CANCEL_REQUESTED→CANCELLED | EXPIRED}. Invalid transitions throw. Local intent and
broker facts stored separately; SUBMITTED never implies FILLED.

## 3. Safety (gate on final payload, TOCTOU, risk separation)

Every submission path runs the Phase 1 gate on the FINAL payload (no bypass; tested
with a mutated-payload trap). Revalidation triggers: risk-decision staleness,
market-data staleness, eligibility change, price drift beyond band, mode change —
any trigger re-runs gate + risk-currency check or blocks. Execution never mutates
risk limits/verdicts/constraints; mismatch → STOP + REVALIDATE. Gate answers payload
safety; risk answers exposure permission; both required. Instrument eligibility +
market freshness + order-type support + lot/tick/min/max + TIF + notional + margin/
funds (reconciled-simulated state; UNKNOWN blocks) + position consistency (expected
vs local vs broker → mismatch reconciles first) all enforced pre-submit.

## 4. Failure handling (UNKNOWN → reconcile; outage → no new risk)

Timeout/reset/5xx/rate-limit/malformed → UNKNOWN (never assumed filled/rejected) →
reconcile by broker order/client tag → adopt authoritative state. Outage flag on
adapter → submissions blocked, state preserved, safe-execution status. Restart:
ledger reload → broker query → reconcile → resume iff clean, else NO NEW RISK.
Retries: safe-retry (transient reads) bounded with backoff; ambiguous submissions
reconcile-first; invalid/rejected/permission/malformed never retried; attempts and
classifications persisted. Rate limiter: token bucket (configurable rate/burst),
queue bounded (cap + drop-newest-with-audit + dead-letter list), no infinite loops.
Kill switch: checked pre-submit and pre-retry; emergency stop blocks new submissions;
existing orders reconciled per policy (cancel only operator-approved or stale/expired).

## 5. Reconciliation (broker authoritative, history preserved)

Diff local vs broker: missing/unknown/duplicate/partial/unexpected/cancelled/
rejected/stale-either-side. Report {before, after, discrepancy, source, ts, result}
per order; broker facts adopted, local intent rows retained. Sim adapter implements
identical query semantics (parity).

## 6. Secrets, TLS, API surface, resources

SecretProvider injected into adapters only; redaction at logger/audit/error paths
(tested: credential-shaped fixtures never surface); no secrets in records/DB/memory/
knowledge. No live HTTP in codebase (verified by scan); TLS 1.3 required by policy
for any future production transport (documented; nothing to disable today). No new
public HTTP execution endpoints in Phase 8 (local calls only) — §49 noted as
not-applicable with rationale. Bounded: queue cap, retry cap, reconcile pass cap,
poll intervals, log append-only (rotation future work, noted).

## 7. Tests (§56) + gates

Units (validation/transitions/idempotency/duplicates/price/qty/lot/tick/market/
eligibility/freshness), gate rules (existing suite + final-payload trap), broker fake
(10 behaviors), reconciliation (7 divergences), restart (crash→reconcile→resume +
uncertain→halt), security (leakage/injection/escalation/replay/duplicates/boundary),
failure scenarios 1–18, live proofs (§59) + hidden-path scan (§60). Then `pnpm test`,
`pytest`, `typecheck`, `lint` (execution boundary rules), `build`, all nine verify
scripts, `docs/audits/phase-8-audit.md` (24 areas + F-P8-1…15), fix CRITICAL/HIGH
(MEDIUM unless proven non-blocking), focused commits, final report. No Phase 9.
