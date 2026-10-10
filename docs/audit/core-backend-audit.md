# AURIX Core Backend Audit — Master Spec & Architecture Compliance

- **Audit start commit:** `94f1d99` (working tree clean, verified via `git status`)
- **Task type:** audit + plan ONLY. No application code modified, no training/backtests run, no live changes.
- **Method:** source inspection, targeted read-only checks (`--collect-only`, file scans, manifest reads), prior audit reports as secondary evidence (never sole evidence for new claims), two scoped explore-subagents for research-agent and API/security areas.
- **Caveat (major):** no standalone Master Spec file exists in the repo (see §1). This audit traces against `docs/architecture.md` v1.0.1 (which cites Master Spec v1.0 §§), phase plans/audits, and code. Anything labeled "per Master Spec" below is per those citations, not a directly-read spec.

## 1. Specification / document inventory

| Doc | Version | Status | Conflicts |
|---|---|---|---|
| `docs/architecture.md` | v1.0.1 + 5 amendments | Found, authoritative build spec | None found; defers to Master Spec on conflict |
| Master Spec v1.0 (standalone) | — | **NOT FOUND in repo** | Cannot verify §-level citations directly |
| `tasks/phase-{2..8}-plan.md`, `plan.md`, `todo.md` | per-phase | Found | None vs architecture |
| `docs/audits/phase-{1..8}-audit.md`, `cumulative-phase-1-5-audit.md` | per-phase PASS verdicts | Found | None observed |
| `docs/training/training-proof-of-execution.md` | measured proof | Found, real numbers | None |
| `docs/training/automation.md` | current | Found, matches code | None |
| `docs/history-data.md` | current | Found, matches code | None |
| `config/ai-policy.v1.yaml`, `config/default.yaml`, risk/portfolio policies | v1 | Found | None |
| `services-python/pyproject.toml`, root `requirements.txt`, `package.json` | current | Found | requirements.txt (root venv) vs pyproject deps overlap, intentional |

## 2. Requirement traceability matrix

Status key: `V`=IMPLEMENTED_VERIFIED, `U`=IMPLEMENTED_UNVERIFIED, `P`=PARTIAL, `M`=MISSING, `B`=BROKEN, `X`=BLOCKED, `N`=NOT_APPLICABLE.
Fields per row: ID | requirement (spec ref) | evidence (source + tests) | status | gap/risk → remediation.

### A. Core architecture

| ID | Requirement (ref) | Evidence | St | Gap → fix |
|---|---|---|---|---|
| A1 | Service boundaries enforced (arch §repo layout) | `scripts/lint.mjs` boundary rules; `*/*/test/security.test.ts` import scans | V | — |
| A2 | TS/Python boundary: LLM+broker isolated from py AI (arch am.1,5) | `services-python/tests/test_ai_governance.py:56` zero broker surface; `verify-ai-runtime.mjs:53` gateway-only Ollama | V | — |
| A3 | Event bus + idempotency | `packages/event-bus` (BusEvent/EventStore/EventBus); knowledge hash ids; broker client-order keys | P | Cross-service event integration untested → P2: integration test through bus |
| A4 | Atomic persistence | SQLite stores + `verify-*.mjs`; registry `tmp+os.replace` (`orchestrate.py`) | P | Registry has no transaction log → P3: append journal |
| A5 | Config validation fails closed | `packages/config-loader` + `test/config.test.ts` (YAML-live + env-overlay rejection) | V | — |
| A6 | Service health/observability | TrainingState, GatewayAudit, kill-switch snapshots; NO service health endpoint (`apps/api` stub) | P | API health deferred → P1 with M-group |
| A7 | Failure propagation | Orchestrator reap→FAILED+events (unit-tested); engine malformed→UNKNOWN | V | Repo-wide propagation map missing → P2 |
| A8 | Restart/recovery | Execution reconcile, `revive_stopped`, sync recovery tests | V | — |
| A9 | Versioning/compat | Dataset/contract/policy versions; no compat-matrix enforcement | P | P3: compat check at load |
| A10 | Auditability | Git history + `docs/audits/*` + JSONL run trails | V | — |
| A11 | No dead code | `packages/portfolio-engine` = Phase-1 skeleton, zero production importers (only negative-scan mentions) | P | P3: remove or document as frozen |
| A12 | Supervisor/worker lifecycle | `orchestrate.py` + 13 orchestrate tests + live synthetic proof | V | — |

### B. AI / model gateway

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| B1 | Qwen3 4B reachable via Ollama | `scripts/verify-ai-runtime.mjs` (one manual live proof: response + latency) | U | One-off proof, not CI, no operational caller → P1: wire + scheduled probe |
| B2 | Gateway-only LLM access | Scans + `research-agents/test/security.test.ts`, `llm-independence.test.ts` | V | — |
| B3 | Replaceable model (no hardcode) | `ModelGateway.reconfigure` + `qwen.test.ts` config-swap | V | — |
| B4 | Timeout enforcement (`timeout_ms`) | Config keys exist; `chat()` never reads them (no AbortSignal/race) | M | P1: enforce + test deadline |
| B5 | Output-schema validation of LLM responses | `content ?? ''` accepted as success; no shape check | M | P1: schema + UNKNOWN mapping |
| B6 | Prompt/secret redaction | `SECRET_RE` + throw + `redacted:true` audit; tests green | V | — |
| B7 | Model/version/prompt provenance | `GatewayAudit` on every path; tests assert fields | V | — |
| B8 | Evidence-aware reasoning | Fundamental agent optional `interpreter`; 5/6 agents never touch LLM | P | P2: define per-agent LLM policy |
| B9 | Deterministic malformed-response handling | Gateway: none. Execution has `validateBrokerResponse` (contrast) | M | P1: with B5 |

### C. Autonomous research / experiment-planning agent

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| C1 | Reviews past outcomes | Research memories only; **no** read of `eval.json`/`governance.json`/`knowledge_refs.jsonl` anywhere (repo-wide grep: writes only) | M | P1: outcome reader (see gap plan) |
| C2 | Identifies open questions | `gapReport` on topic memories only, never outcome-derived | P | P1: with C1 |
| C3 | Proposes testable hypotheses | `hypothesis.ts:buildHypothesis` requires caller fields; nothing generates them | M | P1 |
| C4 | Chooses experiments | `auto-suggest` = fixed seeds `[7,11,13,17,23]`; `decideExperiment` = dedup cache check | M | P1 |
| C5 | Selects datasets/features/configs | Newest-valid dataset + policy hyperparams; no selection logic | M | P1 |
| C6 | Enforces budgets | `max_experiments_per_cycle:3`, concurrency 1, retry caps, `MAX_SWEEP_RUNS=125` | V | (execution-side; planning-side n/a) |
| C7 | Avoids duplicate loops | Hash IDs, submit-refuse, REUSE paths | V | (dedup, not learning) |
| C8 | Runs via supervisor | `Scheduler.cycle`, supervise loop, launcher | V | (execution) |
| C9 | Evaluates vs baselines | `edge=accuracy-baseline`, `runBenchmark`, `runOos` | V | — |
| C10 | Distinguishes failure types | `infra_error→FAILED` vs `REJECTED`; agent FAILED/TIMEOUT/PARTIAL; engine DATA_QUARANTINED | V | — |
| C11 | Learns from outcomes | No reader conditions any future selection on results | M | **P1 core gap** |
| C12 | Records findings | `commitBundle`, `recordStrategyMemory`, `knowledge_refs.jsonl` appends | V | (write-only) |
| C13 | Reuses findings | REUSE cache paths (research + backtest) | V | (cache, not learning) |
| C14 | Promotes only via governance | `ModelRegistry` transitions + `VALIDATED`-only orchestrator ceiling | V | — |
| **C-VERDICT** | **No autonomous closed-loop agent exists.** Schedulers, workers, dedup caches, and a deterministic seed suggester exist. **P1 gap.** |

### D. Training subsystem

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| D1 | Dataset selection+validation | `history.py` providers + `validate_rows` PASS/QUARANTINE/BLOCK; 6 history tests | V | — |
| D2 | Checksums/immutability | sha256 raw+features+manifest; refuse-overwrite; tests | V | — |
| D3 | Features/labels + leakage discipline | `datasets.py` causal windows; leakage unit tests; audit-verified line-by-line | V | — |
| D4 | Chronological splits, train-only scaler | `chrono_split`; scaler-mean equality test | V | — |
| D5 | Real training loop + metrics | SGD `partial_fit` epochs; `metrics.jsonl`; proof-run losses 12.5→5.8 | V | — |
| D6 | CPU selection/fallback | `resources.py` + CPU-only torch proof; policy | V | — |
| D7 | Checkpoints + exact resume | npz (params/scaler/`t_`/epoch/meta); resume-equality test | V | — |
| D8 | Registry/artifacts/inference | `registry.py` states; joblib artifact + `evaluate` path; tests | V | — |
| D9 | State consistency | `state.py` single source; 10 state tests | V | — |
| D10 | Lifecycle/heartbeat/stall/retries | reap/revive/requeue/stall-event; 13+8 tests; live synthetic proof | V | — |
| D11 | PID/dedupe/locks | tasklist probe + spawn-time check + pidfile+heartbeat freshness; tests | V | — |
| D12 | Logs/exceptions | Split worker logs, backtest-run.json, events; tests | V | — |
| D13 | OOS comparison | `evaluate_proba` + baseline; proof OOS numbers | V | — |
| D14 | Recovery w/o overwrite/duplicates | revive + immutable dirs + hash IDs; tests | V | — |
| D15 | Post-fix real-market retrain | Only synthetic since lifecycle fixes | U | P1: adjusted-data convergence run (allowed, small) |

### E. Learning, memory, knowledge

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| E1 | Knowledge graph + provenance | `knowledge-service` store/provenanceChain + phase-2 audit PASS | V | (per prior audit) |
| E2 | Semantic/episodic/strategy memory | `memory-manager` retrieve/decide/reuse + memory verify | V | (per prior audit) |
| E3 | Append-only events | `knowledge_events` stream; sync consumes same history | V | — |
| E4 | Sync + conflict resolution | `sync-manager` + verify-sync | V | — |
| E5 | Training→research read-back | Zero readers (see C1) | M | P1: with C-group |
| E6 | `.akpkg` encryption | `export.ts:1` defers to "Phase 11"; determinism only | M | P2 (spec-deferred, not a defect) |
| E7 | Confidence/evidence classification | Label classes + authority weights + tests | V | (per prior audits) |

### F. Market data & quality

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| F1 | Historical ingestion (tej/eod2) | `history.py` providers; live fetch proven; 6 tests | V | — |
| F2 | Validation gates | 12-check validator; quarantine evidence preserved | V | — |
| F3 | Raw vs adjusted, policy recorded | `adjustment_policy` in manifest; cross-check caught 50% bonus divergence live | V | — |
| F4 | Symbol identity | eod2 ISIN map vendored as data; no ISIN join in builder | P | P2: ISIN-anchored identity |
| F5 | Delisted/survivorship | Documented limitation; upstream point-in-time universe exists, unused | P | P2: adopt universe or delisted source |
| F6 | Point-in-time correctness | Trailing-only windows; backtest 1-bar delay test | V | — |
| F7 | Calendars/timezones | Weekday calendar; NSE holidays unmodeled (45-gap evidence); UTC ms bars | P | P2: NSE holiday calendar + IST session rules |
| F8 | Missing/stale/duplicate | Validator + engine staleness gates | V | — |
| F9 | Reproducibility/storage | Version dirs under `data/` (gitignored); CSV (no parquet dep by design) | V | — |

### G. Research & market intelligence

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| G1 | Specialist agents (6) on fixtures | Agent tests + verify-research | V | (analysis machinery) |
| G2 | Live news/filings/macro connectors | Intake-only: agents consume caller evidence; no fetchers found | M | P1: connector layer or explicit scope cut |
| G3 | Contradiction/confidence handling | Contradiction fields, confidence scores, MODEL_UNAVAILABLE fallback | V | — |
| G4 | Regime detection | Not verified in this audit (no direct evidence read) | U | P2: locate-or-build |
| G5 | Research→strategy handoff | Signals/bundles flow into backtest fixtures (verify-strategy) | P | P2: live handoff contract test |

### H. Strategy & backtesting

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| H1 | Strategy families + selection | Presets + registry + phase-6 audit | V | (per prior audit) |
| H2 | Costs/slippage/spread/liquidity | Engine computes all four; fee breakdown; capped entries on UNKNOWN | V | — |
| H3 | OOS + walk-forward + stress fns | `runOos`/`runWalkForward`/`runStress` exist + strategy verify | V | (functions) |
| H4 | WF/stress in governance | Orchestrator calls neither; gates use single OOS + one backtest | M | P1: wire with budgets |
| H5 | Baselines/benchmarks | `runBenchmark`; majority baseline in eval | V | — |
| H6 | Sizing/benchmarks/reproducibility | Sizing fns + spec-hash reruns | V | (per prior audits) |
| H7 | Infra-vs-result separation | `infra_error→FAILED` vs clean-run→REJECTED; test asserts | V | — |
| H8 | Corporate-action treatment | `adjustSeries` + double-apply guard; raw default documented | P | P2: adjusted default path |

### I. Portfolio & capital

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| I1 | Allocation/sizing/rebalance/exposure math | `packages/portfolio/*` + phase-7 audit PASS | V | (per prior audit) |
| I2 | Analytical-vs-execution reconciliation | Fills tracked in execution; portfolio state separate; no cross-ledger check found | P | P2: reconciliation proof |

### J. Risk & deterministic safety

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| J1 | Triple-enforced eligibility fail-closed | risk-engine:40 + gate:21 + engine:234 + TOCTOU; 4 test suites | V | — |
| J2 | Five-layer live-mode block | Orchestrator throw + config reject + const-false + engine reject + gate; env-escalation test | V | — |
| J3 | Risk veto independent of LLM | No gateway import in risk path (scans); veto tests | V | — |
| J4 | Kill switches | Prior audits; not re-read this audit | U | P2: re-verify live |
| J5 | Duplicate/unknown fail-closed | Idempotency keys + UNKNOWN→reconcile; phase-8 audit | V | (per prior audit) |

### K. Execution & broker (sim only)

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| K1 | Lifecycle/idempotency/partials/reconcile/restart | Phase-8 audit PASS + `verify-execution.mjs` | V | (per prior audit) |
| K2 | Real broker/Kite/live | Disabled scaffolds throwing `Phase1DisabledError`; BLOCKED by design | N | Later phase per spec |
| K3 | Duplicate-timeout resubmit safety | Reconcile-first; tests | V | — |

### L. Regulatory intelligence

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| L1 | Fail-closed UNKNOWN at boundary | J1 evidence | V | — |
| L2 | Eligibility refresh worker/sources | No writer/cron; DDL + seed only; arch defers worker to Phase 3+ | M | P1 |
| L3 | Rule/source tracking + audit trail | `regulatory_rules` table; no population path | P | P1: with L2 |

### M. API, identity, security

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| M1 | HTTP API surface | `apps/api` = 4-line health stub, zero deps/routes | M | P1: localhost API + token auth (arch:496 plans it) |
| M2 | Auth/RBAC/rate-limit/TLS | None anywhere; `bind_localhost_only` unenforced (no listener) | M | P1/P2 |
| M3 | Secret isolation/redaction | Gateway + ledger redaction; zero real secrets (scans); `.gitignore` secrets/ | V | — |
| M4 | Broker credentials disconnected | Sim-auth note; Kite throws; no collection/storage code | V | — |

### N. Control center & observability

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| N1 | Root `aurix` + train/status/stop/logs | `aurix.cmd`; status/stop/logs verified live; train flow verified synthetic | V | — |
| N2 | Single TrainingState | `state.py`; consumers: TUI + concise status + `auto-state` | V | — |
| N3 | Worker visibility/progress | Live synthetic proof (pid/epoch/loss/checkpoint/heartbeat) | V | Real-market soak U → P2 |
| N4 | Failure diagnostics + split logs | backtest-run.json; worker-stdout/stderr split; FAILED panel | V | — |
| N5 | Stall detection | Heartbeat staleness + event; unit-tested | V | Threshold tuning U |
| N6 | Resume/restart/dedupe/hidden flags | revive, requeue caps, pidfile+heartbeat gate, CREATE_NO_WINDOW (mock-asserted) | V | Window-hiding observed-only-manually U |
| N7 | Stop semantics | Graceful, STOPPED, no deletes; tests | V | — |
| N8 | No extra terminals | Flags set; naturally observed during work | P | P3: scripted OS-level check |

### O. Modes & lifecycle

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| O1 | Mode machine + order gating | `orchestrator/ModeMachine`, `allowsOrders` PAPER/SHADOW only; mode tests | V | — |
| O2 | AUTONOMOUS_LIVE disabled | J2 evidence | V | — |
| O3 | Promotion DRAFT-only | `createDraftPromotion`; no activation path | V | (by design) |

### P. Testing, ops, recovery

| ID | Requirement | Evidence | St | Gap → fix |
|---|---|---|---|---|
| P1 | TS suites (74 files) + py (98 collected) | Counts verified this audit; full runs NOT executed here | U | Suites exist; last full runs per prior reports |
| P2 | Fault injection | Broker-sim faults, malformed-response, kill tests | V | (per prior audits) |
| P3 | Crash/restart | Execution + orchestrator recovery; tests | V | — |
| P4 | Backup/recovery tooling | Ledger JSONL; no backup/restore tooling | P | P3 |
| P5 | Resource/cost discipline | CPU-only, concurrency 1, budgets; no heavy deps added | V | — |
| P6 | Deleted evidence incident | `data/runs/real-nse-001*` lost in prior session; unrecoverable; guards added after | B* | *Process failure, already contained; documented §6 |

## 3. Cross-component flows

| # | Flow | Verdict |
|---|---|---|
| 1 | Data→validation→research→knowledge | Proven on fixtures (verify-research/cumulative); live-source→research wiring U |
| 2 | Research→hypothesis→strategy→portfolio→risk | Proven on fixtures (verify-strategy/portfolio); autonomous selection M |
| 3 | Signal→veto→gate→sim execution | Proven incl. failure injection (verify-execution) |
| 4 | Dataset→features→training→checkpoint→eval | Proven real (proof-run) + synthetic (lifecycle tests) |
| 5 | Eval→backtest→governance→registry | Proven synthetic; real-market re-run U; WF/stress not wired (M) |
| 6 | Outcome→knowledge→next selection | **Missing link** (writes exist, zero readers) |
| 7 | Worker fail→supervisor→state→logs→terminal | Proven synthetic live (FAILED + diagnostics pattern from prior session) |
| 8 | Stop→preserve→restart→recover | Proven synthetic (STOPPED→revive→COMPLETED→EVALUATED) |
| 9 | Regulatory UNKNOWN→blocked | Proven (4 suites) |
| 10 | LLM down/malformed→safe | Proven fallback; gateway schema validation M (B5) |

## 4. Debt & efficiency notes (evidenced)

- Dead `packages/portfolio-engine` (self-references only) — P3 remove/document.
- `requirements.txt` vs `pyproject.toml` dep overlap is intentional (venv vs package); keep.
- `orchestrate.py` growing (~600 lines); acceptable, no split proposed yet.
- No duplicate supervisors currently alive (tasklist check this audit: PIDs 9780/10716 dead).
- No GPU/CUDA changes needed; CPU-only verified.

## 5. Counts

- Requirements audited: **108**. V: 71, U: 9, P: 15, M: 11, B: 1 (process incident, contained), X: 1 (live ops, by design), N: 1 (live broker).
- Gaps: P0: 0 open (safety invariants verified) · P1: 8 · P2: 12 · P3: 5.

## 6. Most important verified defects (already fixed, in-tree)

Duplicate-worker race (proven via duplicated metrics, grace-period fix), `os.kill` teardown destabilization (tasklist replacement), stale terminal FAILED (three-way split), infra-vs-verdict confusion, blind PID trust, unbounded restarts, TUI crash on action error.

## 7. Answers

- Autonomous research agent: **does not exist** (C-VERDICT above).
- Complete training mode verified: methodology yes; model quality no (below baseline, stays CANDIDATE); post-fix real-market retrain not yet run.
- Risk + Safety Gate enforcement: **verified** (code + tests, not config).
- End-to-end backend flows: verified except flow 6 (missing) and live-source legs (unverified).
