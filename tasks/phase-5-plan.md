# AURIX Phase 5 Plan — Research & Event Intelligence

Baseline: Phases 1–4 + audits (all PASS). Additive only; no weakening of safety
boundaries. No strategy/portfolio/capital/broker/trading/training/learning/live work.

Principle: **investigate intelligently, never rediscover; traceable evidence-driven
research that compounds.** Every request is memory-first; agents produce structured,
provenance-backed outputs; the Knowledge Service alone writes authoritative knowledge.

## 1. Placement decision (documented)

Phase 5 research lands in TypeScript as `apps/research-agents`, not Python. Rationale:
direct reuse of MemoryManager/KnowledgeStore/market-data without new IPC, deterministic
vitest coverage of the full loop, zero new infrastructure. Python gets a small parity
module (status vocabulary + output-contract field checks). A future Python port can sit
behind the same contracts.

## 2. Contracts (extend `@aurix/contracts`, additive)

`ResearchStatus` = COMPLETED|PARTIAL|INSUFFICIENT_DATA|CONFLICTED|SOURCE_UNAVAILABLE|
DATA_QUARANTINED|MODEL_UNAVAILABLE|TIMEOUT|FAILED. `EvidenceItem {evidence_id, kind,
subject, content, source, source_type, source_identifier, observed_at, retrieved_at,
confidence}`. `ResearchObservation {observation_id, subject, statement, metric?,
value?, period?, methodology, inputs_ref, data_quality, confidence}` (assertion-carrying,
never auto-FACT). `AgentResult {research_task_id, agent, subject, status,
observations[], evidence[], sources[], methodology, assumptions[], contradictions[],
conclusions[], confidence, knowledge_proposals[], created_at, missing[]}` — no trade
fields by construction. `ResearchResultBundle` (persisted node data): task + observations +
evidence + methodology + assumptions + contradictions + confidence + conclusion +
`depends_on[]` + proposal refs. `SourceQualityPolicy {authority: Record<SourceType,number>,
minAuthority, duplicateJaccard}` (configurable, no permanent hard-coded trust).

## 3. Agent interface (common, narrow)

`ResearchAgent {id, topics: string[], run(ctx: AgentContext): Promise<AgentResult>}`.
`AgentContext {task, memories (redacted hits), evidence: EvidenceItem[],
events: MarketEvent[], market: {bars, quotes} (VALID-only, assessed), gaps,
interpreter?: Interpreter, now}`. `Interpreter {interpret(prompt, input): Promise<string>}`
— locally defined; agents never import the gateway (lint-enforced). Interpreter output is
always labeled INFERENCE with model/provenance attached, and only consulted when
deterministic core already produced observations (LLM explains, never evidences).

## 4. Six capabilities (deterministic cores, real but minimal)

- Fundamental: metric inputs `{metric, value, period, source…}` → period-over-period
  growth observations, same-metric+period divergence → contradiction (with possible-cause
  hints: period/basis/revision/scope — stated, never invented), conclusions INFERENCE.
- Technical: VALID-assessed OHLCV only → SMA5/20, trend, ROC momentum, stdev volatility,
  rolling support/resistance, drawdown, timeframe + input range + quality recorded.
  QUARANTINED-only input → DATA_QUARANTINED status, no observations.
- Valuation: P/E, P/B, EV/EBITDA, FCF yield from validated inputs + explicit assumptions +
  uncertainty bands + `calculation_version`; missing inputs → INSUFFICIENT_DATA listing gaps.
- Sentiment: lexicon classification per source (positive/negative word lists, counted hits),
  near-duplicate grouping (Jaccard ≥ threshold, counted once), observation per source +
  aggregate INFERENCE. Sentiment never FACT.
- Macro: indicator observations with value/period/source/publication/revision; revisions
  version prior rows (first values never assumed final).
- EventIntelligence: MarketEvents → structured event nodes + dependency-scoped
  invalidation via memory-manager (only intersecting scopes marked).

## 5. Orchestrator (deterministic, selective)

`ResearchOrchestrator {request → normalize → memory.decide → route → run → collect →
contradict → assemble → commit → task-complete → memorize}`. Agent selection by
topic→agent map (fundamental/technical/valuation/sentiment/macro/event keywords; combined
requests run the union, each once). Never all-agents-by-default; per-agent timeout
(Promise.race → TIMEOUT, others continue → PARTIAL). Memory outcomes: REUSE → return
cached bundle (no agent runs, no LLM); REFRESH → run only agents covering stale topics;
CONFLICT → run only if new evidence exists, else return conflicted bundle; INSUFFICIENT →
run with explicit missing list. Commits agent `knowledge_proposals` through
`KnowledgeStore` (agents never touch the store); FACT assertions left to store policy
(verified: bare agent FACT never lands). Task registry tracks status; agent memory records
(task/actions/sources/conclusions/failures) appended per run.

## 6. Cross-agent contradictions + dependencies

Post-collection pass: same subject+metric, distinct values, both validated-looking →
bundle-level CONFLICT with both chains (mirrors memory semantics). Results record
`depends_on` (entity/metric ids consumed); `affectedTasks(event)` = completed tasks whose
result dependencies ∩ event refs ≠ ∅ → only those become REFRESH candidates (others keep
REUSE). Event flow reuses `applyMarketEvent` + scoped checks (no blind invalidation).

## 7. Failure + timeouts

Agent throws/unreachable → FAILED (bundle PARTIAL if siblings succeed); no VALID data →
INSUFFICIENT_DATA or DATA_QUARANTINED; gateway throws/absent when asked → MODEL_UNAVAILABLE
for the interpretation step only (deterministic core still stands); hanging agent →
TIMEOUT via race. Failed tasks commit nothing authoritative; PARTIAL bundles list `missing[]`.

## 8. Research context discipline + security

Contexts assembled from task + redacted memories + evidence + recent events + VALID market
obs + gaps only (never whole graph/memory). Secrets: knowledge→memory→context→interpreter
path covered by existing ingest rejection + context redaction + gateway redaction (triple
gate, tested end-to-end with a stub interpreter). ACL via `buildAgentContext`.

## 9. No-trading guardrails

Output contract has no order/position/leverage/capital fields (type-level). Lint forbids
broker/execution/risk/portfolio/model-gateway/research-external imports and
placeOrder/BrokerPort/kiteconnect/BUY|SELL-order identifiers in research src. Tests assert
contract shape + scan sources. Agents produce observations/conclusions only.

## 10. Tests (§33 matrix) + proof + gates

Orchestrator (5 memory outcomes), fundamental (5), technical (4+), valuation (4),
sentiment (4), macro (4), events (5), memory-invalidation scoping (4), knowledge commit
path (5), security (3), failure (5: model/source/timeout/quarantine/partial), no-trade
contract (2). `scripts/verify-research.mjs`: real-SQLite §38/§26 proof (RESEARCH→agents→
evidence→knowledge→memory→REUSE; event→scoped REFRESH; quarantine blocks VALID-claims;
agent↛broker/risk/execution). Gates: `pnpm test`, `pytest`, `typecheck`, `lint` (new
research boundary rules), `build`, all five verify scripts, `docs/audits/phase-5-audit.md`
(14 points), fix CRITICAL/HIGH, focused commits, final report. No Phase 6.
