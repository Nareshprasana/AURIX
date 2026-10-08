# AURIX Architecture Specification v1.0.1

**Status:** Approved direction + 5 mandatory amendments applied — implements Master Spec v1.0 §51
**Version:** v1.0.1 (revision of v1.0; Master Spec unchanged, source of truth)
**Stack decision:** TypeScript + Python hybrid, local-first
**Broker target:** BrokerPort abstraction; `broker-sim` only executable in Phase 1; Kite adapter disabled scaffold only
**LLM provider:** Ollama (default) OR stub through Model Gateway; model fully configurable
**Deployment:** Single-machine local-first (Windows/Linux), no cloud dependency, no K8s, no NATS in Phase 1

This document is the buildable translation of the Master Specification. Master Spec remains source of truth; conflicts defer to Master Spec. If an architectural decision conflicts with Master Spec, stop and document — do not invent a resolution. No such conflict found in this revision.

## Changelog v1.0 → v1.0.1 (5 approved amendments)

| # | Amendment | Sections touched |
|---|---|---|
| 1 | LLM model configurable; no `llama3.1:8b` hard dependency; gateway exposes provider/model/endpoint/timeout/generation config | §2, §8, §18, §20 |
| 2 | Vendor/exchange-agnostic core model (`Exchange→Market→Segment→Instrument→Contract`); NSE is config-only initial scope | §3, §5, §10, §11, §12, §16, §18 |
| 3 | New deterministic Order Safety Gate between Risk and Execution with ALLOW/REJECT | §4, §11b (new), §12, §13, §17, repo layout |
| 4 | `knowledge_events` append-only stream as first-class primitive; `.akpkg` includes events; sync consumes same history | §5, §7, §15 |
| 5 | Hard live-trading promotion gate (`LiveTradingPromotion`); config alone never enables live; Phase 1 cannot reach real broker | §12, §13, §14, §18, Phase 1 scope |

ADRs: no separate `docs/decisions/` ADRs created — amendments recorded here to avoid unnecessary artifacts.

---

## 1. Assumptions and constraints

```text
ASSUMPTIONS:
1. Monorepo, private `aurix` repo, MIT license already present.
2. Local-first: all trading-critical paths work offline except market-data fetch,
   Ollama inference (localhost), and broker API calls.
3. Node 20+ and Python 3.11+ available (verified: Node 24, Python 3.14 on arch machine).
   pnpm + uv used. No GPU assumed. No large model auto-download.
4. No live trading until §48 promotion gate passes; default mode is RESEARCH.
5. Even if Zerodha credentials exist on the machine, Phase 1 cannot use them.
→ Correct any assumption before Phase 1 code (see §20; items 2–3 resolved by Amendments 1–2).
```

Hard invariants (Master Spec §49), enforced in code review + Phase 1 tests:

- **A. LLM independence:** knowledge lives in DB/files, never only in model weights or chat history.
- **B. Risk independence:** `risk-engine` is deterministic TypeScript with no LLM dependency; it can veto, AI cannot override.
- **C. Training isolation:** `ml-training` runs as separate process/profile with read-only snapshot datasets.
- **D. Evidence preservation:** FACT/OBSERVATION/INFERENCE/HYPOTHESIS/PREDICTION/UNKNOWN labels + provenance on every knowledge write.
- **E. Versioning:** every decision cites exact versions (knowledge, graph schema, dataset, strategy, model, prompt, risk policy, config).
- **F. Broker reconciliation:** broker state authoritative after restart/failure.
- **G. Safe failure:** UNKNOWN/invalid → no new risk.
- **H. Autonomous operation:** live modes require no per-trade approval once explicitly enabled **via promotion** (Amendment 5).
- **I. Controlled learning:** learning yields CANDIDATE artifacts; governance promotes.
- **J. Portability:** knowledge export/import as encrypted versioned package incl. events.

---

## 2. Tech stack (locked for Phase 1)

| Layer | Choice | Rationale |
|---|---|---|
| Orchestration, API, Risk, Safety Gate, Portfolio, Execution, System health, Promotion check | TypeScript (Node 20+, strict) | Deterministic, testable, single safety-critical path |
| Data/Research/Strategy/Backtest/Learning | Python 3.11+ | Numerical ecosystem, isolated from safety path |
| Orchestrator runtime | TS `apps/orchestrator` + lightweight job DAG | No heavy workflow engine; SQLite-backed state |
| Inter-process protocol | HTTP (REST, localhost) + SQLite event outbox | Debuggable, no daemon; NATS-compatible interface reserved, **not required in Phase 1** |
| Transactional store | SQLite (WAL mode), one file per domain | Portable, zero-ops, crash-safe |
| Analytical store | DuckDB + Parquet (market OHLCV/ticks) — scaffold only in Phase 1 | OLAP without server |
| Knowledge graph | SQLite tables (nodes/edges) + schema version | Zero extra daemon; portable |
| Knowledge events | Append-only `knowledge_events` table/stream (see §7) | Sync/audit/replay/rollback foundation |
| Vector memory | `sqlite-vec` if available, else file-backed embeddings + cosine in Python | Local, versioned |
| TS package manager | pnpm workspaces | Monorepo discipline |
| Python package manager | uv | Reproducible, fast |
| LLM runtime | **Configurable; default provider Ollama** (localhost OpenAI-compatible) **or stub**; model/endpoint/timeout/generation all config-driven (Amendment 1) | Replaceable provider AND model |
| Broker SDK | Phase 1: none. `broker-sim` only. Kite placeholder exposes same `BrokerPort` but throws/disabled (Amendment 5) | Isolate broker coupling; Phase 1 cannot reach real broker |
| Logging | JSONL to `data/logs/`, lightweight TS logger + Python stdlib logging (Phase 1; Pino/structlog optional later) | Audit + grep, minimal deps |
| Config | YAML + TS validation (Zod or hand-rolled in Phase 1 to stay light), env overlay | Fail-fast on bad config |
| Secrets | OS keychain preferred; fallback: age-encrypted file; never in logs/prompts/DB plaintext | Master Spec §37 |
| Tests | Vitest (TS), pytest (Python) | Progressive testing §43 |

No Docker, no K8s, no cloud, no background daemons, no auto model download in Phase 1.

### Amendment 1 — configurable LLM (normative)

- The architecture **must not** name a fixed model (e.g. `llama3.1:8b`) as a dependency. Any such name may appear only as an *example default* in config comments.
- `model_gateway` config schema (see §18):

```yaml
model_gateway:
  provider: ollama | stub      # Phase 1 only these two
  model: <string>              # e.g. "llama3.1:8b" as user choice, not arch lock-in
  endpoint: http://127.0.0.1:11434
  timeout_ms: 30000
  generation: { temperature: 0.2, max_tokens: 1024 }  # provider-passthrough, versioned
```

- Changing provider/model/endpoint/timeout/generation requires **only config + gateway restart** — no agent, knowledge, strategy, or schema change. Verified by test "model replacement without schema migration".
- Gateway supports `stub` (deterministic canned responses, offline) and `ollama` (OpenAI-compatible `POST /v1/chat/completions`). `llama.cpp` or other OpenAI-compatible servers fit the same `ollama`-shaped interface later without caller changes.
- No GPU/hardware assumption. No auto-pull: if the configured Ollama model is absent, gateway returns a clear `MODEL_UNAVAILABLE` error and health triggers safe mode (no new AI trades) instead of downloading.

---

## 3. Repository layout (Phase 1 target)

```text
aurix/
  docs/
    architecture.md
    master-spec.md (reference; Master Spec v1.0 remains source of truth)
  config/
    default.yaml
    risk-policy.v1.yaml
    instruments.yaml      # seed data only; NSE is one scope value, not code
  packages/
    tsconfig.base.json
    contracts/            # generic Exchange/Market/Segment/Instrument/Contract + orders/decisions/events/promotion
    config-loader/
    event-bus/            # SQLite outbox abstraction (NATS-compatible interface, SQLite backend only)
    observability/        # logger, decision-record writer, health types
    risk-engine/          # deterministic veto (no LLM, no network)
    order-safety-gate/    # NEW: deterministic pre-execution payload validation (ALLOW/REJECT)
    portfolio-engine/     # exposure/allocation math (deterministic)
    execution-interface/  # Order types + BrokerPort + reconciliation types
    model-gateway-client/ # typed client (server enforces redaction)
  apps/
    orchestrator/         # workflow state machine + ModeMachine + promotion check
    api/                  # local-only REST skeleton (localhost bind), Phase 1 minimal
    risk-service/
    execution-service/    # enforces Risk→SafetyGate→Sim routing; real-broker impossible
    brokers/
      broker-sim/         # ONLY executable broker in Phase 1
      broker-kite/        # DISABLED scaffold: same interface, always throws Phase1Disabled
    model-gateway/        # stub + ollama providers, redaction, audit
    system-health/        # checks → safe mode
    knowledge-service/    # façade; Phase 1: schema + knowledge_events append + validation stub
  services-python/
    pyproject.toml        # uv workspace; Phase 1: shared stubs only (no prod agents/training)
    aurix_py/             # config parity helpers, event schemas (stub)
    tests/
  data/                   # gitignored runtime
  tasks/
    plan.md
    todo.md
```

Boundaries (enforced by tests + review):

- TS safety path (`risk-service`, `order-safety-gate`, `execution-service`, `portfolio-engine`, `risk-engine`) **must not import** LLM/research/training code.
- Python analytic path **must not import** broker secrets or execution writers.
- Only `model-gateway` talks to Ollama. Only `execution-service`/`brokers/*` talk to broker APIs — and in Phase 1 only `broker-sim` is wired.
- Only `knowledge-service` writes the graph; agents submit proposals; every mutation emits a `knowledge_events` entry (see §7).
- LLM output can never construct a broker call directly (no import path; verified by test).

### Amendment 2 — vendor/exchange-agnostic core (normative)

Generic hierarchy (in `packages/contracts`, used by strategy/portfolio/risk/execution/graph/decision model):

```text
Exchange (e.g. NSE, BSE, MCX — config values, not code branches)
  └─ Market (e.g. equity, equity-derivatives, commodity-derivatives,
              currency-derivatives, interest-rate-derivatives, debt)
      └─ Segment (venue-specific segment code; opaque string + metadata)
          └─ Instrument (canonical id; e.g. ISIN- or exchange:symbol-based; carries lot_size, tick_size, …)
              └─ Contract (expiry/strike/option-type for derivatives; null for spot)
```

- Core instrument model fields: `id, exchange, market, segment, symbol, isin?, lot_size, tick_size, contract?, meta, updated_at`. No NSE-specific enums in core types; venue rules live in `regulatory-intel` data + `eligibility` rows + broker-adapter constraint tables.
- `exchange_scope: [NSE]` remains the initial **configuration** (§18). Adding venues = config + eligibility/adapter data, not core rewrite.
- Strategies, portfolio, risk, execution, graph, and decision record key off the generic model + `eligibility` authority (see §5.3).

---

## 4. Local runtime topology (Phase 1: foundation only, no live orders)

```text
                    localhost only — Phase 1
┌──────────────────────────────────────────────────────────┐
│ Orchestrator (TS)                                        │
│  ModeMachine: RESEARCH default; promotion gate enforced   │
│  Flow: proposal → portfolio → risk → SAFETY GATE → exec  │
└──────┬───────────────────────────────────────────────────┘
       │ HTTP + event outbox (SQLite `events`)
       ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
│ Model Gateway│  │ Knowledge    │  │ Risk / SafetyGate│
│ stub|ollama  │  │ events+store │  │ / Portfolio (sync│
│ (no GPU req) │  │ (append-only)│  │  deterministic)  │
└──────────────┘  └──────────────┘  └────────┬─────────┘
                                             ▼
                                    ┌──────────────────┐
                                    │ Execution service│
                                    │ → broker-sim ONLY│
                                    │ kite = disabled  │
                                    └──────────────────┘
```

Phase 1 runs as OS processes (`pnpm dev` / `uv run`) or single-test in-process. No Kubernetes, no cloud queue, no NATS, no extra containers.

Ports (localhost only; Phase 1 may run in-process without binding): `4100` orchestrator, `4110` api, `4120` risk, `4130` execution, `4140` gateway, `4150` knowledge, `4200` data (stub), `4210` research (stub).

Amended safety flow (Amendment 3):

```text
AI Proposal
     ↓
Portfolio Engine
     ↓
Risk Engine (risk acceptable?)
     ↓
Order Safety Gate (order payload valid right now?)
     ↓
Execution Service (promotion + mode authorized? routes to broker-sim only)
     ↓
Broker Adapter
```

---

## 5. Data and storage design

### 5.1 Files and databases

```text
data/sqlite/
  aurix_core.db      # events, workflows, modes, promotions, instruments, eligibility, regulatory
  knowledge.db       # nodes, edges, knowledge_events, provenance, memories, evidence refs
  portfolio.db       # positions, cash, orders, fills, risk audits, safety audits, decisions
  experiments.db     # candidates... (schema reserved; minimal in Phase 1)
data/duckdb/
  market.duckdb      # reserved (Phase 3+)
data/parquet/
  market/...         # reserved (Phase 3+); training datasets immutable (Phase 10+)
data/blob/
  filings/, news/, evidence/  # content-addressed (sha256)
data/knowledge-exports/
  *.akpkg            # Phase 11; format defined now (§15), implementation later
```

- SQLite WAL mode, `busy_timeout=5000`. Single writer per DB file.
- Phase 1 initializes `aurix_core.db`, `knowledge.db` (incl. `knowledge_events`), `portfolio.db` schemas + `events` outbox; DuckDB/Parquet deferred to Phase 3.

### 5.2 Core tables (Phase 1 DDL scope)

`aurix_core.db`:

- `instruments(id, exchange, market, segment, symbol, isin, lot_size, tick_size, contract_json, meta_json, updated_at)` — generic model (Amendment 2).
- `eligibility(instrument_id, state, reason, source, as_of)` — `LEGAL|RESTRICTED|UNAVAILABLE|UNKNOWN`; UNKNOWN ≠ ALLOWED.
- `regulatory_rules(id, authority, topic, summary, source_url, effective_from, payload_json)` — seed stub Phase 1.
- `market_bars(...)` — **schema reserved, minimal/empty in Phase 1** (full ingestion is Phase 3).
- `market_status(exchange, market, segment, status, as_of, source)` — `OPEN|HALT|AUCTION|CLOSED|UNKNOWN`; UNKNOWN fail-closed. (Supports Safety Gate market-status check.)
- `events(id, type, payload_json, status, idempotency_key, created_at, claimed_by)` — outbox.
- `workflows(id, kind, state_json, status, updated_at)`.
- `modes(current, history_json, updated_at)` + `promotions(...)` (see §13/Amendment 5).

`knowledge.db`:

- `nodes, edges` (Master Spec §12 vocabularies; nodes reference generic instrument ids where applicable).
- `knowledge_events(id, event_type, entity_ref, payload_json, actor, label_class, evidence_refs, prev_version, new_version, created_at)` — append-only; no UPDATE/DELETE (see §7).
- `provenance(...)`, `memories(...)`, `versions(...)` — Phase 1 schema + stub writes.

`portfolio.db`:

- `decisions(...)` — decision record (§16; includes generic instrument ref, versions, risk+safety verdicts, promotion ref).
- `orders(...)` + `fills(...)`, `positions(...)`, `risk_audits(...)`, **`safety_audits(order_ref, verdict, reasons_json, created_at)`** (new).
- `idempotency_keys(key, order_id, created_at)` — duplicate-order protection backing store.

### 5.3 Instrument + eligibility registry

- Seed in `config/instruments.yaml` uses generic fields (`exchange, market, segment, symbol, lot_size, tick_size`); NSE appears only as a data value.
- `eligibility` remains the authority for tradability. Every order path (risk + safety gate + execution) re-checks `state == LEGAL`; `UNKNOWN` blocks (fail-closed).
- `regulatory-intel` full worker is Phase 3+; Phase 1 provides schema + seed + fail-closed checks.

### 5.4 Data quality gates (fail-closed)

Phase 1: schema + `quality_flag` + staleness helpers only; full collector/quality workers are Phase 3. Safety Gate already enforces stale-market-data protection using `as_of` timestamps (see §11b).

---

## 6. Event bus and workflow protocol

Interface (`packages/event-bus`):

```ts
publish(type, payload, opts?: { idempotencyKey?: string }): Promise<Event>
claim(types, worker): Promise<Event[]>
ack(id, worker): Promise<void>
fail(id, error): Promise<void>
```

- Backend: `aurix_core.db.events` only in Phase 1. Poll 250–1000 ms, batch ≤ 50.
- Event types (v1): same as v1.0 + `safety.verdict`, `promotion.decision`, `knowledge.event.appended`, `mode.changed`.
- All events carry `trace_id`, `data_version`, `knowledge_version`, `config_version`.
- Orchestrator owns workflow state; workers idempotent via idempotency keys.

---

## 7. Knowledge platform (with Amendment 4)

- `knowledge-service` owns `knowledge.db` writes. Agents POST proposals; service validates label class + provenance + schema version, then commits.
- Label classes: `FACT|OBSERVATION|INFERENCE|HYPOTHESIS|PREDICTION|UNKNOWN`. LLM output defaults to non-FACT; FACT requires corroboration + validation flag.
- Provenance mandatory: what/when/source/agent/evidence/confidence; `validated` + `outcome_ref` filled later.

### Amendment 4 — `knowledge_events` first-class (normative)

Flow:

```text
Knowledge Mutation proposal
        ↓
Knowledge Event (versioned, append-only)
        ↓
Validation (schema, provenance, label discipline)
        ↓
Knowledge Store apply (nodes/edges/memories + versions bump)
```

- Every meaningful mutation produces one `knowledge_events` row **before/upon** apply, containing: `event_type, entity_ref, full payload/delta, actor, label_class, evidence_refs, prev_version→new_version, timestamp, device_id`.
- The table is append-only (no UPDATE/DELETE API). Corrections are new compensating events. Silent deletes forbidden.
- The event log supports: synchronization (same log shipped incrementally), auditing, replay (rebuild store to any version), conflict resolution (deterministic merge on `(version, device_id)` ordering), rollback analysis, device transfer, version reconstruction.
- `.akpkg` export contains: `manifest, knowledge snapshot, knowledge events, memories, evidence manifest, strategies, experiment metadata, model metadata, embeddings, checksums` (events explicitly included).
- Future sync consumes the same event history with deterministic conflict resolution (last-writer-wins by `(version, device_id)`, history preserved, never silent delete).
- Phase 1 scope: schema + append/validate stub + export-format definition; full sync is Phase 11.

---

## 8. Model gateway (configurable; Amendment 1)

`apps/model-gateway`:

```text
Agent → POST /v1/chat → gateway:
  1. authenticate local caller, load prompt template by (name, version)
  2. load gateway config (provider, model, endpoint, timeout, generation)
  3. redact: blocklist scan for broker secrets / keys / tokens → reject + audit
  4. route to provider: stub (canned) | ollama (POST {endpoint}/v1/chat/completions, timeout)
  5. record audit (prompt_version, provider, model, endpoint, latency, tokens, caller, trace_id)
  6. return text + usage (+ MODEL_UNAVAILABLE instead of auto-download when model absent)
```

- Providers Phase 1: `stub`, `ollama`. `llama.cpp`/other OpenAI-compatible servers reuse the `ollama`-shaped path later.
- Model id + prompt version recorded on every output → decision record.
- No broker secrets through gateway (type boundary + redaction tests).
- No unrestricted shell for LLM agents; allowlisted HTTP tools only.

---

## 9. Agents (Python services)

Phase 1: **workspace + stubs only.** No production collectors, research, debate, strategy, backtest, learning, or training. `services-python/` provides package layout, config/event-schema parity helpers, and a placeholder test suite. Full agents arrive Phases 3–4; training isolation enforced from Phase 10.

---

## 10. Strategy, portfolio, allocation

- Strategy registry/interfaces key off the **generic instrument model** (Amendment 2); venue specifics via eligibility/adapter data, not strategy code branches. Full engine is Phases 5–6.
- Portfolio engine (deterministic TS): exposure/sector/asset/factor/correlation/concentration/liquidity/leverage/margin/cash/P&L/marginal risk contribution. Phase 1: math skeleton + exposure caps used by risk tests.
- Capital allocation stays a separate step; position size = min(strategy size, risk cap, liquidity cap, margin cap).
- Decision actions: `BUY|SELL|EXIT|HOLD|NO_TRADE|REDUCE_POSITION`; `NO_TRADE` is success.

---

## 11. Risk engine (deterministic, veto-only)

`packages/risk-engine` — pure functions, zero network, zero LLM:

```ts
evaluate(proposal, portfolio, marketState, policy): Verdict
// Verdict = { allow: boolean; caps; reasons: string[]; policyVersion: string }
```

Defaults in `config/risk-policy.v1.yaml`: 2% per-instrument; 60% gross (paper/shadow) / 25% controlled-live; 20% sector; leverage 1.0; margin 50%; daily loss 1.5% halt; drawdown 8% global kill; liquidity ≤5% ADV & spread ≤50bps; top-5 ≤40%; abnormal-market haircuts; instrument/strategy overlays.

Risk can only veto/downsize. No AI override. Every verdict → `risk_audits` with policy version. Risk checks generic `exchange/market/segment/instrument` + eligibility + market status (no NSE branches).

## 11b. Order Safety Gate — NEW (Amendment 3, normative)

Location: `packages/order-safety-gate`, pure deterministic functions, zero LLM, zero network. Positioned **between Risk and Execution**:

```text
Risk ALLOW → Safety Gate → ALLOW → Execution | REJECT → never reaches broker
```

Interface:

```ts
validate(cmd: OrderCmd, ctx: SafetyContext): SafetyVerdict
// SafetyVerdict = { verdict: 'ALLOW' | 'REJECT'; reasons: string[]; policyVersion?: string }
// SafetyContext = { instrument, eligibility, marketStatus, riskVerdict, mode,
//                   promotionState, strategyAuth, riskState, nowTs, decisionTs,
//                   marketDataTs, idempotencyKey, seenKeys, brokerConstraints, qtyCaps }
```

Must validate where applicable: instrument identity, exchange, segment, eligibility (`LEGAL` only), market status (HALT/AUCTION/UNKNOWN block entries), side, quantity (>0, ≤ max, integer), lot size (qty % lot == 0), tick size (price % tick == 0 within epsilon), order type, price (>0 for limit; sanity vs last price), notional caps, max quantity, duplicate protection (idempotency key seen), stale decision (now - decisionTs > TTL), stale market data (now - marketDataTs > threshold), current risk state (halt/kill active → REJECT), strategy authorization (strategy approved for instrument/mode), mode authorization (only modes+promotion allowing orders), idempotency presence, broker constraints via abstraction (min/max qty, price bounds, segment rules).

Properties:

- Deterministic; ALLOW/REJECT + detailed reasons; persisted to `safety_audits`.
- LLM can never override; REJECT never reaches broker (execution-service enforces: no gate ALLOW → no route).
- Independent of Risk: Risk says "risk acceptable", Gate says "order payload valid right now". Both must ALLOW.
- Malicious/incorrect proposal tests required (§17 lists 15+ cases).

---

## 12. Execution and broker abstraction

`packages/execution-interface`:

```ts
interface BrokerPort {
  readonly kind: 'sim' | 'kite-disabled';
  placeOrder(cmd): Promise<BrokerOrder>;
  cancelOrder(id): Promise<void>;
  modifyOrder(id, patch): Promise<void>;
  fetchOrder(id): Promise<OrderState>;
  fetchPositions(): Promise<BrokerPosition[]>;
  fetchFunds(): Promise<Funds>;
}
```

- `execution-service` lifecycle: mode+promotion authorized? → eligibility re-check → **require Risk ALLOW + SafetyGate ALLOW** → route → track (partials/rejects/cancels) → slippage/quality → reconcile.
- Never assumes fill. Reconciliation loop (30 s live; always on startup): broker authoritative; divergence → risk event + safe mode.
- `broker-sim`: fills at touch ± spread/slippage/fees; partials, rejects, halts for failure tests. **Only executable broker in Phase 1.**
- `broker-kite`: **disabled scaffold** exposing `BrokerPort` but every method throws `Phase1DisabledError` and factory refuses to construct when `broker != 'sim'`. No credentials read, no network, no `kiteconnect` dependency in Phase 1. Real implementation deferred to Phase 9 and additionally gated by promotion (Amendment 5).

---

## 13. Modes, health, safety, recovery (with Amendment 5)

Mode machine: `RESEARCH → BACKTEST → SHADOW → PAPER → CONTROLLED_LIVE → AUTONOMOUS_LIVE` (Phase 1 implements the machine + RESEARCH/SHADOW/PAPER transitions; live transitions exist as states but are **unreachable** without promotion — see below).

Health checks → safe mode matrix (same as v1.0: stale data / broker unstable / risk breach / model unavailable / corrupted state → no new risk; deterministic exits still allowed where safe).

Kill switches: trade / strategy / agent / model / global (API + config + auto).

Crash recovery: restart → read-only broker connect → load actual positions/orders → reconcile → health → resume only if safe.

### Amendment 5 — hard live-trading promotion gate (normative)

New first-class concept `LiveTradingPromotion` (owner: orchestrator + `promotions` table + `packages/contracts` types):

```text
LiveTradingPromotion {
  promotion_id: string
  system_version: string
  risk_policy_version: string
  model_version: string
  strategy_versions: string[]
  validation_results_ref: string   // backtest/OOS/walk-forward/stress refs
  paper_trading_results_ref: string
  approval_timestamp: string | null
  operator_identity: string | null
  state: DRAFT | SUBMITTED | APPROVED | ACTIVE | SUSPENDED | REVOKED
}
```

Rules:

1. `mode: AUTONOMOUS_LIVE` (or any live mode) in YAML **alone never enables live orders**. Execution-service verifies `promotions` row with `state == ACTIVE` (plus mode, risk policy, model/strategy version match, operator + timestamp present) on every live-order path.
2. No `ACTIVE` promotion can exist in Phase 1: promotion creation/activation code is stubbed to `DRAFT` only, and execution-service additionally hard-codes `allowLive = false` with a test proving Phase 1 cannot reach a real broker even if credentials exist.
3. Real-broker factory path does not exist in Phase 1 (only `broker-sim` wired; `broker-kite` throws). Later phases add the factory **behind** the same promotion check.
4. Downgrade/suspend/revoke transitions are audited (`promotion.decision` events); any health/risk trigger suspends live eligibility immediately.

Phase 1 defaults: `mode: RESEARCH, broker: sim`. Impossible path `Phase 1 → real broker → real order` is proven by tests (factory + import + network-attempt assertions).

---

## 14. Learning, validation, governance

Pipeline per Master Spec §25 with `experiments.db` ledger; training isolation (read-only snapshots → versioned artifacts, never production DBs/execution); registry states `CANDIDATE|TESTING|PAPER|APPROVED|PRODUCTION|DEPRECATED|REJECTED|ROLLED_BACK`; calibration; benchmarks; microstructure costs.

Phase 1: schema reservations only. No training, no production learning loop, no promotion activation (ties to Amendment 5).

---

## 15. Knowledge transfer and sync (with Amendment 4)

`.akpkg` (zip) contents (normative):

```text
manifest.json (versions, checksums, created_by, min_compatible)
knowledge snapshot (graph.jsonl)
knowledge events (knowledge_events.jsonl)   # REQUIRED by Amendment 4
memories (memories.jsonl)
evidence manifest (evidence_manifest.jsonl)
strategies/
experiment metadata (experiments_summary.json)
model metadata (model_metadata.json)
embeddings/ (versioned)
checksums.sha256
```

Encrypted (age/XChaCha, recipient pubkey) + integrity-checked; dry-run diff before merge. Sync (Phase 11) ships incremental `knowledge_events` and merges deterministically (`(version, device_id)` order; history preserved; never silent delete). Phase 1: format + schema only.

---

## 16. Decision record and observability

Every shadow/paper/live decision persists: `decision_id, ts, generic instrument ref (exchange/market/segment/instrument/contract), market_state, data_versions, evidence_refs, knowledge_refs (+ knowledge event ids), research outputs, bull/bear/skeptic memos (later phases), strategy+model+prompt versions, portfolio snapshot, risk calc + policy version, safety verdict + reasons, promotion ref + mode, execution request/result, outcome`.

Local API (localhost only, token auth) exposes activity/decisions/orders/portfolio/risk/model/strategy/data-quality/health/experiments/knowledge diffs. JSONL logs with `trace_id`; secrets redacted. Frontend deferred; API+CLI first.

---

## 17. Testing strategy (maps to Master Spec §43–44; Phase 1 gates)

| Level | Tool | Scope |
|---|---|---|
| Unit | Vitest / pytest | risk math, safety-gate matrix, quality/eligibility fail-closed, gateway redaction |
| Integration | Vitest (+ node:sqlite) | event outbox, knowledge-event append, gateway→stub/ollama-shape, execution→sim |
| Failure matrix (Phase 1 subset) | scripted tests | stale/dup/outlier fixtures; risk reject; partials; dupes; crash/restart reconcile |

Phase 1 required suites (must all pass):

- Risk: allowed / oversized / exposure violation / unknown eligibility / invalid market state.
- Safety Gate: invalid instrument, invalid qty, lot, tick, duplicate, stale decision, stale data, restricted, wrong mode, missing risk verdict (+ wrong symbol/exchange, zero/negative/oversized qty, stale price, unknown, halted, risk-invalid).
- Gateway: stub, ollama interface shape, redaction, audit, model swap without migration.
- Event bus: publish, claim, ack, failure/retry, idempotency.
- Broker-sim: create, fill, partial, reject, cancel, reconcile.
- Safety proofs: LLM↛broker; LLM↛bypass risk; risk-reject↛execution; Phase1↛real broker; UNKNOWN↛trade.
- Python: workspace smoke + contract parity.

Coverage gate: safety path 90%+ before Controlled Live (tracked from Phase 1).

---

## 18. Configuration reference (Phase 1 defaults)

`config/default.yaml`:

```yaml
mode: RESEARCH            # RESEARCH | SHADOW | PAPER | CONTROLLED_LIVE | AUTONOMOUS_LIVE (live unreachable in Phase 1)
broker: sim               # sim ONLY in Phase 1; any other value fails validation
exchange_scope: [NSE]     # config-only initial scope; core stays generic (Amendment 2)
model_gateway:
  provider: stub          # stub | ollama (Phase 1); model configurable (Amendment 1)
  model: stub-echo-v1     # example only — change freely, no code change needed
  endpoint: http://127.0.0.1:11434
  timeout_ms: 30000
  generation: { temperature: 0.2, max_tokens: 1024 }
data:
  timeframes: [1m, 5m, 15m, 1h, 1D]
  staleness_s: { 1m: 120, 1D: 86400 }
safety:
  bind_localhost_only: true
  require_risk_verdict: true
  require_safety_gate: true
  unknown_means_blocked: true
  allow_live: false       # Phase 1 hard-coded false; promotion gate additionally required later
promotion:
  state: DRAFT            # Phase 1 only DRAFT exists; ACTIVE impossible
```

`config/risk-policy.v1.yaml`: §11 limits + kill thresholds + regime haircuts (`risk policy v1`).
`config/instruments.yaml`: generic seeds (`exchange, market, segment, symbol, lot_size, tick_size`).

---

## 19. Build order (maps to Master Spec §47)

1. **Phase 1 — Local foundation (this plan):** contracts, config-loader, event-bus, observability, model-gateway (stub+ollama-shape), SQLite bootstrap (+ knowledge_events), orchestrator skeleton (modes + promotion DRAFT), sim broker, execution skeleton (Risk→Gate→Sim), safety gate, risk skeleton + policy, decision record stub, health skeleton. Exit: `pnpm test` + `pytest` + typecheck/lint green.
2. **Phase 2 — Knowledge platform:** graph writes, provenance enforcement, memories, versioning, export builder (incl. events).
3. **Phase 3 — Market data:** eligibility/regulatory workers, fetcher abstraction, quality gates, DuckDB/Parquet.
4. **Phase 4 — Research + debate.** 5. **Phase 5–6 — Strategy + cost-aware backtest.** 6. **Phase 7 — Portfolio + risk hardening.** 7. **Phase 8 — Shadow/paper E2E.** 8. **Phase 9 — Execution + Kite + reconciliation.** 9. **Phase 10 — Learning/registry/governance.** 10. **Phase 11 — Encrypted sync (event-driven).** 11. **Phase 12 — Controlled live (promotion ACTIVE path, explicit approval).**

Each phase ends with tests + audit + spec update. No phase-skipping.

---

## 20. Open questions (residual; Amendments 1–2 resolved the prior items 2–3)

1. Node 20+/Python 3.11+ floor with pnpm+uv — confirmed by Amendment instruction; re-confirm if other floors required.
2. Localhost-only API + token auth sufficient for Phase 1? (assumed yes)
3. `sqlite-vec` permitted later, else file fallback? (Phase 1 needs no decision; deferred to Phase 2)
4. Preferred example Ollama model name for local dev docs (docs-only, not arch)?

---

## 21. Success criteria (architecture review)

- [x] 5 amendments recorded above with normative rules.
- [ ] Every Master Spec §6–§50 capability maps to exactly one owner (§19).
- [ ] Safety path has zero LLM/network imports (lint + tests).
- [ ] UNKNOWN blocks trading in risk AND safety gate.
- [ ] Decision record answers "why this trade?" from versions + evidence + event ids.
- [ ] Knowledge survives model swap (stub ↔ ollama) without migration (test).
- [ ] Phase 1 cannot construct or reach a real broker (test).
- [ ] Live requires ACTIVE promotion, not config (code + test).

---

## Appendix A — Master Spec compliance (14-point verification, this revision)

1. LLM independence intact — §7/§8: knowledge in DB + events; gateway swap needs no migration (test).
2. Risk independence intact — §11/§11b: pure functions; LLM cannot override either gate (tests).
3. Training isolation intact — §14: read-only snapshots; Phase 1 contains no training path.
4. Evidence/provenance mandatory — §7: validation stub enforces fields from Phase 1 schema on.
5. Versioning mandatory — §5/§16: versions table + decision refs.
6. Broker reconciliation authoritative — §12: sim reconcile loop + startup reconcile (tests).
7. UNKNOWN fail-closed — §5.3/§11/§11b: three independent blocks (risk, gate, execution) + tests.
8. Autonomous operation after proper promotion — §13/Amendment 5: supported, never by config alone.
9. Learning candidate-based — §14: candidates only; governance promotes; Phase 1 none active.
10. Knowledge portable — §15: `.akpkg` incl. events; Phase 1 format+schema.
11. No real broker reachable in Phase 1 — §12/§13: only sim wired; kite throws; factory test.
12. LLM cannot bypass risk/execution safety — §11b/§12: gate + execution require ALLOWs; import-path test.
13. Knowledge survives LLM replacement — gateway config-only swap (test).
14. Training cannot interfere with live execution — no training code path in Phase 1; isolation designed in §14.

No Master Spec conflict detected. No Spec change proposed.
