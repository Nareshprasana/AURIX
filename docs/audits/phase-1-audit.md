# AURIX Phase 1 Audit Report

**Audit scope:** Phase 1 local foundation — architecture compliance, security boundaries,
risk safety, order-safety tests, mode machine, broker isolation, database, event bus,
observability, TS/Python boundary, training isolation, repository hygiene, full test execution.
**Commit audited:** `b593a49`
**Audit+fix commit:** see §14
**References:** Master Specification v1.0 (source of truth), `docs/architecture.md` v1.0.1,
`tasks/plan.md`, `tasks/todo.md`, implementation at `b593a49`.
**Auditor method:** independent re-read of implementation + repo-wide searches + test execution.
Tests passing was treated as necessary but not sufficient; every safety claim was re-proven
against the code.

---

## 1. Architecture requirements checked (5 amendments)

| # | Amendment | Verdict |
|---|---|---|
| 1 | Configurable LLM (provider/model/endpoint/timeout/generation; no model lock-in) | PASS — `GatewayConfig` carries all five; `reconfigure()` swaps without agent/contract changes (test); `MODEL_UNAVAILABLE` instead of download (test); no auto-pull code exists; no GPU assumption anywhere |
| 2 | Vendor-agnostic `Exchange/Market/Segment/Instrument/Contract` | PASS — repo-wide search finds no `case 'NSE'`/venue branches in contracts, risk, portfolio, execution, knowledge, orchestration, safety gate. `NSE` occurs only as fixture/config data values (`config/instruments.yaml`, test fixtures) and in a contracts comment; enforced by `contracts.test.ts` |
| 3 | Order Safety Gate on path Proposal→Portfolio→Risk→Gate→Execution→Broker | PASS — `routeOrder` enforces Risk ALLOW then `validateOrder` ALLOW then sim-only routing; no alternate path exists (only caller is the test suite; kite adapter has no route); gate validates the actual `OrderCmd` payload independently |
| 4 | `knowledge_events` append-only + `.akpkg` includes events | PASS — schema has the table; service exposes append/validate only (no update/delete API exists); validation-before-apply + duplicate rejection tested; `.akpkg` format in architecture §15 lists `knowledge events` |
| 5 | `configuration != authorization` (promotion gate; Phase 1 `isLiveAllowed == false`; kite dead) | PASS — `isLiveAllowed` returns false even for `ACTIVE`; `ModeMachine` throws on live transitions; config validation rejects live modes and non-sim brokers incl. via env overlay (tested); `BrokerKiteDisabled` throws on every method; `createBroker('kite')` throws |

---

## 2. Security findings

- **Repo-wide secret search** (`KITE|BROKER|API_KEY|API_SECRET|ACCESS_TOKEN|PASSWORD|TOKEN|SECRET|OLLAMA`, case-insensitive): hits are **only** (a) redaction patterns in `model-gateway` + `observability`, (b) fake fixture strings (`'XYZ'`, `'abc'`) in redaction tests, (c) docs/tasks prose, (d) package/config keys. **No real credential, token, or secret material exists anywhere.**
- **LLM→prompt leakage:** gateway blocks inputs matching the secret regex (`SECRET_REDACTED` + audit entry, tested); observability `redact()` strips secret-bearing keys before JSONL write (tested). Error messages carry reason strings only, never secrets.
- **Broker isolation:** only `execution-service`/`brokers/*` reference `BrokerPort`; gateway source contains no broker symbols (test asserts); Python package has zero broker/execution imports and no network code.
- **LLM tool surface:** no `child_process`, `execSync`, `spawn`, `eval(`, `new Function`, or training code anywhere in `packages/`, `apps/`, `services-python/`, `scripts/` (verified by search). No unrestricted shell/tool capability exists.
- **Result:** no security finding above INFORMATIONAL. Git history contains no secrets (single scaffold commit + initial commit).

## 3. Risk findings

- **F1 (MEDIUM, FIXED):** `evaluate()` did not enforce four architecture-§11 controls even though the policy file defined them: `max_margin_util_pct` (`marginUtilPct` was collected but ignored), `concentration_top5_pct`, liquidity caps (`liquidity_max_adv_pct`, `liquidity_max_spread_bps`), and the abnormal-regime haircut (`abnormal_states`/`abnormal_market_haircut_pct` unused). Deterministic core was sound, but policy coverage was incomplete. **Fix:** all four enforced (regime haircut reduces the notional cap; margin/concentration/liquidity reject with reasons); inputs optional so earlier callers still compile. Risk suite extended 5→9 tests.
- Post-fix, the full chain holds deterministically with no LLM dependency: Risk REJECT ⇒ `routeOrder` throws before the gate/broker (tested, sim shows zero positions); Risk ALLOW + Gate REJECT ⇒ `routeOrder` throws (tested); UNKNOWN ⇒ rejected at risk, gate, and execution layers (tested). Position/exposure/leverage/margin/concentration/liquidity/stale-data/market-state checks are pure functions.

## 4. Execution findings

- **F2 (MEDIUM, FIXED):** gate did not enforce the architecture's `quantity (…integer)` rule (fractional qty with `lot_size: 1` slipped the `qty % lot` check only by accident of modulo) and ignored `brokerMinQty` although the field exists in contracts. **Fix:** explicit `Number.isInteger` rejection + broker-minimum rejection, both with reasons and tests.
- **F3 (LOW, FIXED):** `routeOrder` relied solely on the gate for mode/promotion authorization. Real-broker impossibility never depended on this (no real broker implementation exists and `kind !== 'sim'` throws), but defense-in-depth required an independent check. **Fix:** explicit Phase 1 live-mode rejection at the top of `routeOrder` + test proving rejection even with `promotionActive: true` on the sim broker.
- Gate matrix now covers 25 cases, all exercising the real `validateOrder` (no mocks): wrong symbol/exchange/segment, zero/negative/fractional/oversized/below-min quantity, lot, tick, stale price, stale decision, stale data, duplicate, missing idempotency, unknown/restricted/UNKNOWN instrument, halted market, risk halt, wrong mode, missing/risk-REJECT verdict, invalid side, invalid order type, MARKET happy path, valid ALLOW.
- Kite adapter reference audit: imported **only** by `safety.test.ts`; never by any `src/` file. Every method throws `Phase1DisabledError`; factory throws for any non-sim kind; `config-loader` rejects `broker: kite` including via `AURIX_BROKER` env (tested).

## 5. Database findings

- WAL: every DDL file starts `PRAGMA journal_mode=WAL` + `busy_timeout=5000` (test-asserted; `verify-sqlite.mjs` executes all three DDLs on real `node:sqlite` plus an outbox round-trip).
- Keys/constraints: PKs on all tables; `events.idempotency_key` UNIQUE; INTEGER timestamps; version columns present. **F5 (LOW, FIXED):** claim polling had no index — added `idx_events_poll(status, type, created_at)`.
- `:memory:` note: vitest cannot load `node:sqlite` (Vite externalization), so bus tests use an exact-behavior `MemoryStore` while real-SQLite execution is proven by `scripts/verify-sqlite.mjs` (plain node). This is documented in code and does not hide a WAL problem (WAL applies to file DBs; `:memory:` correctly reports `memory`).
- Deferred (INFORMATIONAL): no FK constraints (acceptable Phase 1 — single-writer services, no relational traversal yet); recommend FKs in Phase 2.

## 6. Event-bus findings

- `publish/claim/ack/fail/retry/idempotency` all tested against real behavior (not mocked): publish, claim→ack lifecycle, fail→retry with `attempts` increment + `last_error`, idempotent republish returning the original event, type-filtered claim.
- Simulated failure between creation and processing: `fail()` preserves the event with error + retry count; the event is re-claimable, never silently lost (tested).
- Duplicate delivery cannot cause duplicate execution: at-least-once delivery is now documented in code; `publish` collapses duplicate idempotency keys and execution deduplicates via `idempotency_keys` (schema present). Unbounded FAILED retry noted as a later-phase dead-letter improvement (INFORMATIONAL).

## 7. Mode/promotion findings

- `RESEARCH` default; `SHADOW`/`PAPER` reachable; `CONTROLLED_LIVE`/`AUTONOMOUS_LIVE` throw on transition **and** fail config validation (YAML and env-overlay paths both tested). Restart always yields `RESEARCH` (tested) — no escalation possible.
- **F4 (LOW, FIXED):** transitions (including rejected live attempts) had no audit record. **Fix:** append-only `ModeTransition` log (`from/to/at/allowed/reason`) + tests.
- Promotion: `DRAFT`-only creation; `isLiveAllowed` false for every state including hypothetical `ACTIVE` (tested). `mode: AUTONOMOUS_LIVE` in YAML cannot enable trading — three independent blocks: config validation, mode machine, execution live-gate — plus the absence of any real broker implementation.

## 8. Testing findings

- Gate tests exercise the implementation (zero mocks in safety path); gateway Ollama test injects a stub fetch — appropriate since it tests the interface shape, not the network.
- **F6 (LOW, FIXED by test):** env-var escalation was rejected by code but unproven — added failing-path tests for `AURIX_MODE=AUTONOMOUS_LIVE` and `AURIX_BROKER=kite`.
- Coverage: risk 9, gate 25, gateway 6, bus 5, sim 6, safety proofs 6, config 7, mode 6, knowledge 3, contracts 2, portfolio 2, health 2, observability 1, db 3 — 83 TS + 2 Python, all passing with typecheck + lint + real-SQLite proof.

## 9. Git/repository findings

- `git status` clean at audit start; `.gitignore` excludes `.env`, secrets, tokens, `data/`, logs, weights, datasets, `*.akpkg`, build/dep dirs — verified: `node_modules/`, `services-python/.venv/`, and any runtime artifacts are untracked-and-ignored (nothing to clean).
- No credentials in tracked files (see §2). `pnpm-lock.yaml` committed for reproducibility; contains no secrets.

## 10. Severity classification

| ID | Severity | Status |
|---|---|---|
| F1 risk-policy gaps (margin/concentration/liquidity/haircut) | MEDIUM | FIXED + tested |
| F2 gate gaps (integer qty, broker min) | MEDIUM | FIXED + tested |
| F3 execution live-gate defense-in-depth | LOW | FIXED + tested |
| F4 mode transition audit log | LOW | FIXED + tested |
| F5 events poll index | LOW | FIXED + verified |
| F6 env-escalation proof tests | LOW | FIXED (tests) |
| O1–O6 (FKs, dead-letter, decision DB wiring, `:memory:` docs, price bounds, trace convention) | INFORMATIONAL | Documented, deferred to Phase 2+ |

No CRITICAL or HIGH findings. No Master Spec conflict detected; no Spec change proposed.

## 11. Required fixes

All safety/security/execution/risk/promotion/data/event findings (F1–F6) were fixed before declaring
Phase 1 complete, each followed by test → verify (see §13).

## 12. Final verification (Phase 1 proof)

```text
LLM X Broker                 ✓ (import-path test + type boundary + redaction tests)
LLM X Risk bypass            ✓ (execution requires risk verdict; gateway has no broker path)
Risk REJECT X Execution      ✓ (throws before gate/broker; sim shows zero positions)
Safety REJECT X Broker       ✓ (gate REJECT throws; nothing routed)
UNKNOWN eligibility X Trade  ✓ (blocked at risk, gate, execution)
YAML mode change X Live      ✓ (validation + machine + execution gate; env paths tested)
Phase 1 X Real broker        ✓ (kite throws on all methods; factory throws; sim-only routing)

Broker simulator ✓  Risk engine ✓ (9)  Order Safety Gate ✓ (25)  Mode machine ✓ (6)
Knowledge event foundation ✓  Audit logging ✓  Deterministic safety path ✓ (lint + tests)
```

## 13. Test results (post-fix, executed)

- `pnpm test`: **14 files, 83 tests, all pass**
- `pnpm typecheck`: clean — `pnpm lint`: `lint ok: safety-path import boundaries hold`
- `node scripts/verify-sqlite.mjs`: all three DDLs execute on real `node:sqlite`; outbox round-trip ok
- `pytest` (`services-python`): **2 passed**

## 14. Final verdict

**PASS** — Phase 1 is architecturally compliant with Master Spec v1.0 and architecture v1.0.1
(all five amendments proven in code and tests), security boundaries hold, and all required
fixes are applied and verified. The six INFORMATIONAL observations are non-blocking and
recorded above for Phase 2+. Phase 2 may proceed only on explicit owner approval.
