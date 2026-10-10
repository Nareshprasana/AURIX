# AURIX Core Backend Gap Plan (prioritized remediation)

Source: `docs/audit/core-backend-audit.md` (108 requirements). No code changed in this audit.

> Phase 2 update: P1-2 through P1-8 implemented and targeted-tested (see report).
> P1-1 was completed in `df77e8a`. TS knowledge-service ingestion of research
> records remains P2. Research connectors decided intake-only (decision record
> `docs/audit/research-connectors-decision.md`).

## P1 gaps (required core/autonomy)

### P1-1. No autonomous research/experiment-planning agent (C1–C5, C11, E5, flow 6)
- Evidence: `auto-suggest` = fixed seeds; zero readers of eval/governance/knowledge outcomes.
- Impact: training runsBlind variations; no learning; compute wasted; autonomy claim false.
- Fix (minimal): outcome-reader module (eval+governance+backtest JSON → scored summary) → hypothesis proposer constrained to (dataset, feature-flag subset, model_type, hyperparameter grid, budget) → validated experiment definitions through existing `validate_definition` → selection policy preferring high-uncertainty/underexplored configs with duplicate-hash guard. Read-back of `knowledge_refs.jsonl` into research context.
- Acceptance: new exp differs after a REJECTED run for a recorded reason; unit test with fixture histories; no duplicate IDs; budgets respected.
- Verify: synthetic histories + one tiny live loop. Cost: MEDIUM. Deps: none.

### P1-2. Model below baseline; no converged retrain (D15, training readiness)
- Status (Phase 2): IMPLEMENTED_VERIFIED (synthetic). `LogRegLBFGS` solver with
  convergence flag, validation-only early stopping, base-rate floor, run
  diagnosis (UNDERFIT/OVERFIT/INCONCLUSIVE/FAILED/CONVERGED), manifest fields;
  `model_type` threaded through CLI/research/worker/resume. No real-market
  retrain launched (explicitly deferred, reported separately).
- Evidence: proof OOS 48.25% vs 50.35% baseline; train loss 5.8 vs 0.69 base-rate.
- Impact: no PROMOTABLE model exists; registry has CANDIDATEs only.
- Fix: adjusted dataset + fit-to-convergence (LBFGS or 200+ SGD passes + early stopping) + cost-aware label review; small run only.
- Acceptance: val loss ≈ base-rate; OOS reported honestly; still CANDIDATE unless gates pass.
- Verify: manifest + metrics inspection. Cost: LOW (CPU minutes).

### P1-3. Walk-forward/stress not in governance (H4)
- Status (Phase 2): IMPLEMENTED_VERIFIED (synthetic + fixture). Gate script
  `--walkforward`/`--stress` modes; orchestrator runs both post-base-gate
  with budgets; infra errors → FAILED, poor results → REJECTED with reason;
  thresholds are explicit policy (`min_median_sharpe: 0.0` floor,
  `max_stressed_dd_pct`), not spec claims.
- Evidence: `runWalkForward`/`runStress` exist, orchestrator never calls them.
- Impact: single-split luck can promote; regime fragility undetected.
- Fix: wire both as post-backtest gates with budgets (reuse `methods.ts`), failure → REJECTED with reason; infra errors → FAILED.
- Acceptance: unit test with fixture splits; gate blocks a cherry-picked single-split winner.
- Verify: targeted tests + one synthetic loop. Cost: LOW.

### P1-4. Gateway timeout + response-schema validation (B4, B5, B9)
- Status (Phase 2): IMPLEMENTED_VERIFIED. AbortSignal deadline, bounded
  retries (5xx/429 only, backoff 100/400/1600ms), strict content schema,
  input cap, classified `GatewayError`s, attempts/errorCode audit fields.
- Evidence: `timeout_ms` unread; `content ?? ''` accepted.
- Impact: hung inference stalls research; garbage becomes "reasoning".
- Fix: AbortSignal deadline + strict response schema → MODEL_UNAVAILABLE/UNKNOWN mapping; keep redaction/audit.
- Acceptance: deadline test with fake clock/hung fetch; malformed-body test.
- Verify: gateway tests only. Cost: LOW.

### P1-5. Qwen operational wiring (B1, B8)
- Status (Phase 2): IMPLEMENTED_VERIFIED (stubbed; live probe explicitly
  deferred). `gatewayInterpreter` factory + per-agent policy (fundamental
  only by default); research boundary untouched (lint clean); deterministic
  default preserved (no auto-enable). Live Qwen smoke test NOT run.
- Evidence: zero production callers; only fundamental agent has optional interpreter slot.
- Impact: LLM capability exists but unused; analyst-assistant path dead.
- Fix: wire interpreter in orchestrator with `llmRequired=false` default (deterministic core stands), per-agent policy, audit trail; keep kill-switch independence.
- Acceptance: stub-interpreter test + live manual probe (not CI).
- Verify: unit tests. Cost: LOW.

### P1-6. Eligibility refresh worker + rule tracking (L2, L3)
- Status (Phase 2): PARTIAL (approved portion only). Pure
  seed/validate/resolve module with source/as_of/version provenance and
  stale→UNKNOWN fail-closed; full regulatory-intel worker remains Phase 3+
  per architecture (no source invented).
- Evidence: DDL only, no writer; `as_of` unenforced.
- Impact: eligibility goes stale silently; UNKNOWN-default is safe but blind.
- Fix: minimal refresh worker (NSE announcements/seed file + `as_of` timestamps + staleness → UNKNOWN rule); populate `regulatory_rules`.
- Acceptance: refresh updates `as_of`; stale entry forces UNKNOWN; boundary tests unchanged.
- Verify: fixture-driven worker test. Cost: MEDIUM.

### P1-7. Local API + token auth (M1, M2, A6)
- Status (Phase 2): IMPLEMENTED_VERIFIED (localhost only). Stdlib-only
  `aurix_ai.api`: bearer token (env, ≥16 chars, fail closed), loopback-only
  bind, per-IP rate limit, 64 KiB cap, redacted audit log, generic errors;
  routes reuse CLI/TUI functions (state/events/start/stop); `serve` command;
  no broker/risk surface (static test).
- Evidence: 4-line stub; arch:496 plans localhost+token.
- Impact: frontend has no backend to talk to; no health endpoint.
- Fix: minimal localhost HTTP service exposing TrainingState read + start/stop (same fns as CLI), token auth, request-size/rate limits; no new framework (stdlib `http.server` or existing dep only).
- Acceptance: auth rejection test, route tests, no broker/risk exposure.
- Verify: targeted API tests. Cost: MEDIUM.

### P1-8. Live-source research connectors or explicit scope cut (G2)
- Status (Phase 2): DECIDED (intake-only cut). Decision record
  `docs/audit/research-connectors-decision.md`; no scraping, no new
  connectors, no credentials.
- Evidence: intake-only agents, no fetchers.
- Impact: research cannot refresh from the world; event intelligence is fixture-fed.
- Fix: either minimal NSE-announcement/filing fetcher with provenance + quarantine, or architectural decision recording intake-only scope.
- Acceptance: decision recorded; if built, provenance tests.
- Verify: fixtures. Cost: MEDIUM (build) / LOW (decision).

## P2 gaps (integration/reliability/validation)

- **P2-1.** Training→research read-back (E5): outcome summaries into research context; depends on P1-1.
- **P2-2.** akpkg encryption (E6): spec-deferred to Phase 11; implement when phase arrives.
- **P2-3.** Laya pipeline role: installed + proven, unused; define advisory role or cut scope. LOW.
- **P2-4.** NSE holiday calendar + IST sessions (F7): 45-gap evidence; engine treats holidays as sessions. MEDIUM.
- **P2-5.** ISIN-anchored identity (F4) + delisted/survivorship source (F5): adopt universe/delisted feed. MEDIUM.
- **P2-6.** Adjusted-price default path (H8): parquet reader justification or eod2-adjusted default. LOW.
- **P2-7.** Portfolio↔execution reconciliation proof (I2). LOW.
- **P2-8.** Kill-switch live re-verification (J4) + secure-error audit (M4 secure errors). LOW.
- **P2-9.** Regime detection locate-or-build (G4) + research→strategy live handoff test (G5). MEDIUM.
- **P2-10.** Backup/restore tooling for ledgers/registries (P4). LOW.
- **P2-11.** TUI real-market soak + no-window OS-level check (N3/N8). LOW.
- **P2-12.** Cross-service event integration + compat matrix (A3/A9). MEDIUM.

## P3 gaps (nonessential)

- **P3-1.** Remove or freeze-document dead `packages/portfolio-engine`.
- **P3-2.** Registry transaction journal (A4).
- **P3-3.** Stall-threshold tuning from observed data (N5).
- **P3-4.** TUI polish; docs drift pass.
- **P3-5.** Perf pass only on measured hotspots.

## Phases with exit criteria

- **Phase A (autonomy core):** P1-1 + P1-2 + P1-3. Exit: closed loop demonstrated on synthetic histories (selection changes for recorded reasons); converged retrain reported; WF/stress gate blocks a rigged winner; no duplicate IDs; budgets hold.
- **Phase B (trustworthy I/O):** P1-4 + P1-5 + P1-6 + P1-8(decision or fetcher). Exit: deadline/schema tests; live probe manual; eligibility freshness enforced; scope decision recorded.
- **Phase C (serve + harden):** P1-7 + P2 selection. Exit: authed local API serving TrainingState; prior suites green; audit updated.

## Entry criteria

- **Frontend work may begin when:** Phase C exit + `auto-state` schema frozen + auth tests green. Frontend remains visualization-only (no training/risk/promotion/broker logic).
- **Final broker integration may begin when:** registry holds a VALIDATED model through full gates (incl. WF/stress), eligibility refresh live, API authed, independent safety re-audit PASS, explicit user authorization. AUTONOMOUS_LIVE stays disabled until its own promotion gate (arch §48) passes.

## Unresolved conflicts / decisions needed

1. **Master Spec standalone file absent** — audit traced via architecture + phase docs. Decision needed: accept this corpus as spec or reproduce the Spec.
2. **Research connectors:** build vs intake-only scope cut (P1-8).
3. **Laya role:** advisory integration vs removal from architecture.
4. **Backtest-runner empty-stdout flake** (one user-trial occurrence, unreproduced, stderr capture added): accept monitoring vs invest in root-cause harness.
5. **Deleted `data/runs/real-nse-001*` evidence:** unrecoverable; process guards now in-tree. No action possible beyond documentation here.
