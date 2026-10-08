# AURIX Phase 1 Plan — Local Foundation

Implements `docs/architecture.md` v1.0.1 §19 item 1. Master Spec is source of truth.
Scope is foundation ONLY. No real broker, no live trading, no prod agents/training/sync.

## 1. Workstreams (build order)

1. **WS0 repo hygiene:** `.gitignore` verify, `package.json` + `pnpm-workspace.yaml`, `tsconfig.base.json`, `config/*.yaml`, root test/typecheck/lint scripts.
2. **WS1 contracts:** generic `Exchange/Market/Segment/Instrument/Contract`, eligibility, market status, orders, risk/safety verdicts, decisions, promotions, knowledge events, broker constraints. No NSE branches.
3. **WS2 config-loader:** YAML + env overlay, strict validation (`broker: sim` only, `allow_live: false`, gateway provider stub|ollama, model free-string).
4. **WS3 SQLite bootstrap:** `aurix_core.db` / `knowledge.db` / `portfolio.db` DDL incl. `knowledge_events` (append-only), `safety_audits`, `idempotency_keys`, `modes`, `promotions`, WAL + busy_timeout.
5. **WS4 event-bus:** SQLite outbox `publish/claim/ack/fail` + idempotency + retry; NATS-compatible interface, SQLite backend only.
6. **WS5 observability:** JSONL logger (no secrets), decision-record writer, audit helper.
7. **WS6 model-gateway:** `stub` + `ollama`-shaped providers, config-driven provider/model/endpoint/timeout/generation, redaction blocklist, audit log, `MODEL_UNAVAILABLE` (no auto-download).
8. **WS7 orchestrator:** ModeMachine (RESEARCH default; SHADOW/PAPER reachable; live unreachable), promotion check (DRAFT only; `allowLive=false`), workflow skeleton.
9. **WS8 safety path:** `risk-engine` skeleton + `risk-policy.v1.yaml`; `order-safety-gate` full matrix (§11b); `portfolio-engine` exposure skeleton.
10. **WS9 execution:** `execution-interface` types + `BrokerPort`; `broker-sim` (fills/partials/rejects/cancels/reconcile); `broker-kite` disabled scaffold (always throws); `execution-service` enforcing Risk ALLOW + Gate ALLOW + sim-only + promotion/mode.
11. **WS10 system-health + api skeletons:** checks → safe-mode signal; localhost API stub.
12. **WS11 knowledge-service skeleton:** schema + `knowledge_events` append/validate stub (no prod graph writes beyond tests).
13. **WS12 Python workspace:** `uv` project, parity helpers, pytest smoke + contract parity.
14. **WS13 tests/audit:** `pnpm test`, `pytest`, `tsc`, lint; safety-proof suite; commit.

Out of scope (explicitly deferred): real broker/Kite live, autonomous-live capability, full ingestion, prod research/strategy, training, learning loop, full sync, frontend.

## 2. Verification gates

- `pnpm test` green (risk 5, gate 15+, gateway 5, bus 5, sim 6, safety 5+).
- `pytest` green.
- `pnpm typecheck` + `pnpm lint` (or documented equivalent) green.
- `.gitignore` blocks `.env/secrets/data/logs/weights/exports`.
- Safety proofs: LLM↛broker, LLM↛bypass, risk-reject↛execution, Phase1↛real broker, UNKNOWN↛trade.
- `git status/diff` reviewed; focused commit.

## 3. Risks

- `node:sqlite` API differences across Node versions → pin docs to Node 20+; keep SQL simple.
- YAML parsing without heavy deps → vendored minimal parser or `js-yaml` single dep.
- Windows paths in scripts → use `node:` path APIs, no shell-specific syntax in tests.
