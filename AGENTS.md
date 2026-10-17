# AURIX Engineering Operating Policy (AGENTS.md)

This file is the repository-specific operating policy for coding agents working
in AURIX (Autonomous Unified Risk & Intelligence eXchange). It supplements —
never overrides — the approved architecture (`docs/architecture.md` v1.0.1),
the Master Spec reconstruction (`docs/audit/master-spec-reconstruction.md`
v0.2), the final decision sheet (`docs/audit/final-decision-sheet.md`), and
all documents under `docs/audit/` and `docs/audits/`. If any rule below
conflicts with an authoritative existing decision, the existing decision wins:
document the conflict and stop instead of silently changing the decision.

Authoritative quick references (verified 2026-10-13; re-verify before relying
on them if the tree has moved on):

- Root scripts (`package.json`): `pnpm test` → `vitest run`; `pnpm typecheck`
  → `tsc --noEmit -p tsconfig.json`; `pnpm lint` → `node scripts/lint.mjs`;
  `pnpm build` → `tsc -p tsconfig.build.json`; `verify:*` scripts
  (`verify:research`, `verify:execution`, …) for subsystem proofs.
- Python tests: project `.venv` python, e.g.
  `.venv/Scripts/python -m pytest services-python/tests/test_ai_api.py -q`.
  System python may lack ML deps (`sklearn`, `joblib`); use the project venv.
- Safety chain: `packages/risk-engine` → `packages/order-safety-gate` →
  `apps/execution-service` → `apps/brokers/broker-sim` (only executable kind).
- Knowledge writes: `apps/knowledge-service` only, via
  propose → validate → commit (`apps/knowledge-service/src/store.ts`).
- Training lifecycle: `services-python/aurix_ai/orchestrate.py`
  (`Scheduler`, `ExperimentRegistry`); policy
  `config/ai-policy.v1.yaml`; local API `services-python/aurix_ai/api.py`.

## 1. Project identity and operating constraints

- AURIX is a **local-first, single-machine** trading and research system
  (Windows/Linux; Node 20+, Python 3.11+; no cloud dependency, no K8s, no NATS
  in Phase 1 — `docs/architecture.md:8,33`).
- TypeScript owns the deterministic safety path (orchestration, API, risk,
  safety gate, portfolio, execution, promotion); Python owns the numerical
  path (data, research, strategy, backtest, learning), isolated from safety
  decisions (`docs/architecture.md:59-60`).
- The system operates **research-only, simulation-only**. Default mode is
  RESEARCH; the only executable broker kind is `sim`
  (`apps/execution-service/src/engine.ts:209-212`,
  `apps/execution-service/src/index.ts:35-36`).
- No cloud/Kubernetes migration, no new daemons/services, no heavy workflow
  engines, and no unnecessary infrastructure expansion as part of ordinary work.

## 2. Non-negotiable trading safety

- Preserve the Risk Engine's **veto-only** role: pure deterministic functions,
  no network, no LLM (`packages/risk-engine/src/index.ts:1`); it can only
  veto/downsize, and AI output can never override it.
- Preserve the fail-closed order path in order: **Risk Engine → Order Safety
  Gate → Execution Service → BrokerSim**. Both Risk ALLOW and Safety-Gate
  ALLOW are required before anything reaches a broker.
- Preserve the disabled live-trading controls: `allow_live: false`
  (`config/default.yaml:24`), `allowLive` hard-coded false with config unable
  to enable live orders (`apps/orchestrator/src/index.ts:61`), the Kite
  adapter as a disabled scaffold whose every method throws
  (`apps/brokers/broker-kite/src/index.ts:32-34,91-96`), and promotion-gated
  activation (ACTIVE promotion row required; Phase 1 can only produce DRAFT).
- Never enable live trading, connect real broker execution, bypass a safety
  check, weaken a risk limit, or change trading-mode/broker defaults as part
  of ordinary development — even if asked casually. Any future live-trading
  proposal requires an **explicit approved decision** plus a separately
  reviewed safety implementation. Never infer approval from a passing test,
  a green build, or a successful simulation.
- Treat broker interfaces, order validation, risk evaluation, mode/promotion
  checks, and execution routing as security-sensitive boundaries (see §6).
- For changes touching these paths, test rejection paths first: malformed
  orders, restricted/unknown eligibility, stale decisions and market data,
  duplicates and idempotency-key reuse, wrong modes, and fail-closed outcomes.
  Wrong-symbol/exchange, zero/negative/oversized quantity, lot/tick
  violations, and halted/unknown markets must all REJECT without reaching
  any broker surface.

## 3. Knowledge and state integrity

- Preserve KnowledgeStore's **append-only event semantics**
  (`apps/knowledge-service/src/index.ts:2`) and the
  **propose → validate → commit** workflow (`store.ts:80,107,163`).
  Agents submit proposals; only the service writes. Never add a direct graph
  mutation path or bypass validation.
- Every meaningful mutation emits one `knowledge_events` row before/upon
  apply; corrections are new compensating events, never UPDATE/DELETE
  (`docs/architecture.md` §7/Amendment 4).
- Preserve sync conflict handling (deterministic merge on
  `(version, device_id)`, history preserved, never silent delete),
  memory-freshness bands (FRESH/AGING/STALE/UNKNOWN with stale → UNKNOWN
  fail-closed), deterministic serialization (`stableStringify`), and
  hash-based dedup of hypotheses/experiments.
- Verify transactional, concurrency, and recovery behavior before changing
  any persistence semantics; SQLite single-writer and crash→restart→reconcile
  flows are load-bearing.

## 4. Python research and training lifecycle

- Preserve the experiment lifecycle
  `QUEUED → RUNNING → COMPLETED → EVALUATED → BACKTESTED → VALIDATED |
  REJECTED` with `FAILED`/`CANCELLED` terminal otherwise
  (`orchestrate.py:4,28-29`), and the retry discipline: only FAILED may be
  requeued (capped); a REJECTED governance verdict is terminal and can never
  be retried (`orchestrate.py:163`).
- Never promote on accuracy alone. VALIDATED requires the governed gates:
  OOS edge vs baseline, backtest drawdown cap, walk-forward median-Sharpe
  floor, and stress drawdown cap, with infrastructure failures classified
  FAILED (retryable) and poor results REJECTED
  (`orchestrate.py:485-541`, `config/ai-policy.v1.yaml:69-96`).
- A median-Sharpe floor of zero is a non-negativity sanity check, **not**
  evidence of profitability. Never describe a candidate as profitable or
  deployment-ready from gate passage.
- Training runs as an **isolated, long-running workload independent of the
  coding agent**: at most one heavy job
  (`max_concurrent_training: 1`, `ai-policy.v1.yaml:65`), workers as separate
  processes writing only their own `data/runs/<id>/` directory. Agent builds,
  tests, and runs must never stop, corrupt, restart, overwrite, or otherwise
  disturb active training or its artifacts (run dirs, datasets, checkpoints,
  manifests, registries).
- Require immutable/versioned datasets (refuse-overwrite on checksum
  mismatch), checkpoints with exact resume, isolated temp-only directories
  for destructive tests, and bounded budgets/concurrency per project design.
- Do not launch expensive training or **real-market retraining** without
  explicit authorization (U10 remains deferred; retraining is a separately
  authorized operation).

## 5. Data provenance and research intake

- Preserve the documented source roles: tej-bazaar (raw bhavcopy) for audit
  archives; eod2 split/bonus-adjusted as the **training-build default**
  (`history-build --provider` defaults to `eod2`; `history.py:70,103`).
  Residual: eod2 dividends are unadjusted — do not claim otherwise.
- Every dataset manifest must record `adjustment_policy` + `source`; submitted
  experiments carry denormalized `price_basis`/`data_source`. Raw and adjusted
  builds must use **distinct dataset IDs** (version IDs hash the spec, not the
  basis; same-spec collisions refuse with DATASET_CORRUPT rather than mixing).
  Comparisons must use compatible price bases.
- Research intake is **evidence-driven and intake-only** (U7 decided cut,
  `docs/audit/research-connectors-decision.md`): agents consume
  caller-supplied evidence; boundary lint forbids fetcher imports in research.
  Do not introduce scrapers, live fetchers, credentials, or unaudited
  third-party data dependencies without a sourced, licensed feed plus ToS
  review and an explicit approved decision.
- Keep history reproducible: raw archives, adjusted datasets, and derived
  artifacts stay distinguishable with checksums and provenance. Never rewrite
  historical proof artifacts; re-baselining creates new, traceable results.
  Never invent holiday dates, ISIN mappings, or thresholds.

## 6. API and application security

- The local training API (`services-python/aurix_ai/api.py`) is
  **bearer-token on loopback only**: constructor refuses non-loopback binds
  and missing/short tokens (fail closed); identical auth on every route
  including `/health`; 60/min per-IP rate limit; 64 KiB request cap; audit log
  with credentials redacted; generic error bodies. Preserve all of these.
- Never hard-code credentials or expose secrets, tokens, private keys, or
  account data in code, logs, prompts, tests, or docs. Broker secrets must
  never pass through prompts, context, or logs.
- Malformed inputs (`interval`, `timeout`, `last`, JSON bodies) must produce
  controlled 4xx responses, never uncaught exceptions or dropped connections.
  Single-threaded request serialization is an operational property, not a
  security guarantee — do not claim otherwise.
- Add tests for authorization boundaries (every route, valid/invalid/missing
  tokens), injection and malformed payloads, replay/idempotency, rate and
  size limits, and audit-log leakage. Never weaken a security control or
  remove a safety assertion to make tests pass.

## 7. Engineering workflow

- Inspect the relevant code, tests, package boundaries (`packages/*/`,
  `apps/*/`, `services-python/aurix_ai/`), config, and existing decisions
  (especially `docs/audit/`) before modifying anything. Reuse existing
  services, validators, and helpers; do not duplicate canonical logic.
- Make the smallest coherent change that satisfies the requirement. Follow
  established TS strict-mode and Python stdlib-first conventions. Avoid new
  dependencies (especially heavy numerical/platform ones) without a recorded
  justification; never upgrade unrelated packages as a side effect.
- Preserve backward compatibility (CLI flags, manifest schemas, registry
  states, API routes) unless a breaking change is explicitly approved.
- Update documentation and tests when behavior or contracts change. Never
  claim verification that was not actually performed; distinguish executed
  checks from inherited report claims.

## 8. Testing and verification

- Identify the relevant package-level tests first (`apps/*/test/`,
  `packages/*/test/`, `services-python/tests/test_*.py`, `scripts/verify-*.mjs`).
  Run focused tests first (`npx vitest run <path>`, targeted pytest), then
  broader checks (`pnpm test`, `pnpm typecheck`, `pnpm lint`) when resources
  permit. Some `verify-*.mjs` scripts require a built `dist/` — check and
  report the blocker rather than working around it.
- For safety-critical changes include boundary, failure-path, regression, and
  security tests (see §2/§6). Use deterministic synthetic fixtures in temp
  directories; never run real-market training, real backtests, GPU/LLM
  workloads, or broker-connected execution as verification.
- Report results precisely: PASS (executed, green), FAIL (executed, red with
  evidence), BLOCKED (could not execute, with reason), NOT RUN (not attempted).
  Never weaken a test or delete a safety assertion to obtain green.

## 9. Graphify usage

- Consult the Graphify knowledge graph (`graphify-out/graph.json`,
  `graphify-out/GRAPH_REPORT.md`, `graph.html`) for architecture exploration,
  dependency tracing, community relationships, and impact analysis before
  changing unfamiliar code. Useful entry points: god nodes (`KnowledgeStore`,
  `ExperimentRegistry`, `Scheduler`, `BrokerSim`, `fail()`), the
  `fail_closed_safety_flow` / `safe_execution_chain` /
  `governed_training_promotion` hyperedges, and community labels.
- Verified CLI flows: `graphify query "<q>"` (BFS; `--budget N` caps tokens),
  `graphify path "<a>" "<b>" [--undirected]`, `graphify explain "<node>"`,
  `graphify export html`, `graphify benchmark`.
- Use the graph to **discover candidate dependencies, then verify important
  ones in source code**. Graph relationships and generated summaries are
  discovery aids, not proof.
- A missing graph path does **not** prove no source dependency exists
  (doc-concept nodes can sit on wording islands while code edges connect).
- High node degree does **not** by itself establish excessive coupling or
  justify a refactor (e.g. `vitest`, `stableStringify` are legitimately central).
- Refresh the graph when source changes make it stale, using the installed
  Graphify workflow at the smallest appropriate scope (prefer incremental
  update over full rebuild; avoid repeated full extractions while the graph
  is valid). Never hand-edit generated graph files or treat them as source
  of truth.

## 10. Git and audit discipline

- Inspect `git status --short` and the relevant diffs before and after every
  change; record starting/ending commits. Never assume untracked or dirty
  files belong to the current task — this tree has carried pre-existing
  untracked artifacts (`graphify-out/`, audit reports); leave unrelated ones
  untouched and never overwrite existing audit evidence.
- Never use destructive Git commands (reset --hard, clean, push --force,
  history rewrites) without explicit authorization. Do not stage, commit, or
  push unless the task explicitly assigns commit ownership; default to leaving
  changes uncommitted and reported.
- Follow the repo's commit style when committing is assigned
  (`ai(scope): …` with evidence in the body). Keep changes focused and
  review the full diff before finishing.
- Keep audit claims traceable to evidence (`file:line`, test name + result,
  commit hash). Clearly distinguish **implementation** (what changed) from
  **verification** (what was executed, with results) from **inherited claims**
  (prior reports, not re-executed).

## 11. Resource efficiency

- Respect limited compute, memory, API usage, and free-tier quotas. Avoid
  unnecessary parallel builds, duplicate test runs, broad re-indexing
  (including Graphify full rebuilds), and expensive model calls.
- **Never interrupt active training to free resources for development.**
  Before heavy operations, identify owner, cost, output location, and
  interruption risk; prefer targeted inspection and focused tests over
  full-suite execution.
- Ask before any unusually expensive, destructive, or externally
  consequential operation (network fetches, new data sources, large downloads,
  paid services, outbound communication).

## 12. Policy maintenance

- This file may only record rules traceable to verified repository evidence
  or authoritative decisions. Do not invent scripts, commands, APIs, paths,
  or architectural guarantees — verify first, then document.
- Rules that could not be verified against source at the time of writing are
  listed below and must be treated as provisional until confirmed.
- If a required rule conflicts with an authoritative existing decision,
  document the conflict here instead of changing the decision.

### Provisional / unverified at time of writing (2026-10-13)

- Exact live GPU/Qwen runtime behavior beyond the stub-tested gateway paths
  (no live probe executed for this file).
- Full-suite green status (only targeted suites were executed during
  verification; `verify-*.mjs` scripts needing built `dist/` were not run).
- No known conflicts with existing authoritative decisions at time of writing.
