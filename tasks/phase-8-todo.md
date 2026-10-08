# AURIX Phase 8 TODO

From `tasks/phase-8-plan.md`. Phases 1–7 suites (387 TS + 17 py) must stay green.

## Design
- [x] `tasks/phase-8-plan.md`
- [x] `tasks/phase-8-todo.md` (this file)

## Broker interface (`packages/execution-interface`, additive)
- [ ] Extended BrokerPort (auth/account/positions/orders/place/modify/cancel/instrument/quote/margin) + generic types
- [ ] ExecutionRequest + OrderRecord (15 states) + legal transition table
- [ ] Idempotency/duplicate policy + reconcile report + retry classification + kill-switch + secret-provider types

## Execution service (`apps/execution-service`, from skeleton)
- [ ] Planner (intents → requests, risk-currency checks) + TOCTOU revalidation
- [ ] Lifecycle engine (gate-on-final-payload, submit, track, cancel policy)
- [ ] Timeout→UNKNOWN→reconcile; partial-fill accounting (idempotent fills)
- [ ] Reconciliation engine (broker wins facts, history preserved)
- [ ] Restart recovery (ledger reload → query → reconcile → resume-if-safe)
- [ ] Rate limiter + bounded retry/backoff + persisted classifications
- [ ] Kill switches + emergency stop (reconcile-first cancel policy)
- [ ] JSONL ledger + redacted audit + LiveSubmissionGate (all-false, each blocking)

## Brokers
- [ ] broker-sim: full interface + deterministic fault injection + reconciliation queries
- [ ] broker-kite: extended disabled stubs (no HTTP/SDK/credentials) + activation checklist docs

## Python parity
- [ ] Order states + retry classes mirrors + tests

## Proof script
- [ ] `scripts/verify-execution.mjs` (§57 loop + 18 scenarios + §59 + §60 scan)

## Tests (§56)
- [ ] Units, gate rules, broker fake (10), reconciliation (7), restart, security, scenarios 1–18

## Audit + verify + commit
- [ ] `pnpm test`, `pytest`, `typecheck`, `lint`, `build`, all nine verify scripts
- [ ] `docs/audits/phase-8-audit.md` (24 areas + F-P8-1…15, severity)
- [ ] Fix CRITICAL/HIGH (MEDIUM unless non-blocking); focused commits; final report (no Phase 9)
