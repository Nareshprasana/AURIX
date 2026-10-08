# AURIX Phase 1 TODO

Generated from `tasks/plan.md` + architecture v1.0.1. Check off only when tests pass.

## WS0 — repo hygiene
- [x] Verify `.gitignore` (env/secrets/data/logs/weights/exports)
- [x] `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, root scripts
- [x] `config/default.yaml`, `config/risk-policy.v1.yaml`, `config/instruments.yaml`
- [x] `pytest`/`uv` workspace scaffold

## WS1 — contracts
- [x] `packages/contracts`: generic instrument model, eligibility, market status, orders, verdicts, decisions, promotion, knowledge events
- [x] Unit: generic model has no NSE-specific branches; UNKNOWN ≠ ALLOWED type discipline

## WS2 — config-loader
- [x] Loader + validation (broker sim-only, allow_live false, gateway provider/model/endpoint/timeout/generation)
- [x] Unit: rejects `broker: kite`, rejects `allow_live: true`, accepts any model string

## WS3 — SQLite bootstrap
- [x] DDL for core/knowledge/portfolio incl. knowledge_events/safety_audits/idempotency/promotions; WAL
- [x] Unit: knowledge_events append-only (no update/delete API); promotion defaults DRAFT
- [x] Real-SQLite proof: `node scripts/verify-sqlite.mjs` (node:sqlite DDL + outbox round-trip; vitest uses MemoryStore)

## WS4 — event-bus
- [x] publish/claim/ack/fail + idempotency + retry over SQLite-compatible store
- [x] Tests: publish, claim, ack, failure/retry, idempotency

## WS5 — observability
- [x] JSONL logger with redaction; decision-record writer; audit helper

## WS6 — model-gateway
- [x] stub + ollama-shaped providers; config-driven swap; redaction; audit; MODEL_UNAVAILABLE
- [x] Tests: stub, ollama interface, redaction, audit, model swap without migration

## WS7 — orchestrator
- [x] ModeMachine + promotion check (DRAFT only, allowLive=false)

## WS8 — safety path
- [x] risk-engine evaluate + policy; portfolio exposure skeleton
- [x] order-safety-gate validate (full §11b matrix)
- [x] Tests: risk 5; gate 19 cases

## WS9 — execution
- [x] BrokerPort + broker-sim (create/fill/partial/reject/cancel/reconcile)
- [x] broker-kite disabled scaffold (always throws Phase1Disabled)
- [x] execution-service: requires Risk ALLOW + Gate ALLOW + sim-only + mode/promotion
- [x] Tests: sim 6; risk-reject never routes; Phase1 cannot reach real broker

## WS10 — health/api skeletons
- [x] system-health checks → safe-mode signal; api localhost stub

## WS11 — knowledge-service skeleton
- [x] knowledge_events append/validate stub

## WS12 — Python workspace
- [x] `services-python` uv project + smoke/parity tests; `pytest` green (2 passed)

## WS13 — verify + commit
- [x] `pnpm test` green (14 files, 67 tests)
- [x] `pytest` green (2 passed)
- [x] typecheck + lint green
- [x] safety-proof suite green (LLM↛broker, LLM↛bypass, risk-reject↛exec, no real broker, UNKNOWN↛trade)
- [ ] `git diff`/`status` reviewed; focused commit; report per instructions
