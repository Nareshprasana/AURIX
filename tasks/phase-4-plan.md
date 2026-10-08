# AURIX Phase 4 Plan — Memory-Aware Market Intelligence + Data Quality

Baseline: Phases 1–3 + audits (PASS). No rewrite of Phases 1–3; additive only.
No full research agents, strategy, brokers, training, or live trading.

Principle: **remember the right things, know when they are stale, know where they came
from, avoid doing the same expensive work twice.** Memory ≠ truth ≠ current state ≠
permission to skip verification. Freshness, confidence, validation, truth stay separate.

## 1. New code (additive, reuses Phase 2/3 contracts)

- `packages/market-data` — pure TS, zero node imports: vendor-neutral provider interfaces
  (Market/Quote/Bar/CorporateAction/Instrument), canonical normalized types (explicit
  timezone, provenance), deterministic quality engine (VALID/SUSPECT/QUARANTINED),
  quarantine store (provenance + reason retained, never deleted), per-domain freshness
  policies, minimal event foundation (corporate-action/earnings → MarketEvent).
- `apps/memory-manager` — deterministic engine over `KnowledgeStore` (node:crypto/fs only
  via existing observability logger): unified retrieval with filters, heuristic relevance
  (explicitly labeled), per-domain freshness (FRESH/AGING/STALE/UNKNOWN, configurable),
  reuse decision (REUSE/REFRESH/RESEARCH/CONFLICT/INSUFFICIENT — LLM cannot override),
  ResearchTask registry + normalized-key/similarity dedup, gap reports
  (KNOWN/UNKNOWN/STALE/CONFLICTED/MISSING), invalidation marking
  (STALE/SUPERSEDED/CONTRADICTED/INVALIDATED, history preserved), budget info
  (effort estimate, evidence counts, history), agent-context builder (redacted, ACL),
  typed agent-memory + trading-experience builders.
- `services-python`: tiny parity mirrors (freshness classify, quality verdict) + tests.
- `scripts/verify-memory.mjs`: real-SQLite demo of the §33 proof (RESEARCH→REUSE→REFRESH→CONFLICT) + timing.

## 2. Memory retrieval (deterministic)

`retrieve({entityодерж...})` — filters: entity, security, instrument, topic, event,
strategy, agent, time range, memory type (layer), validation state, confidence band.
Scans `snapshotNodes/snapshotMemories` (Phase 4 scale; indexed later). Returns records +
retrieval metadata (why matched). Natural language is never the only mechanism.

## 3. Relevance (honest heuristics)

Each hit carries `{relevance_score (0..1, HEURISTIC), matched_on: string[], memory_type,
source_entity, created_at, last_verified_at, confidence, validation_state, provenance_ref}`.
Score = weighted: entity/topic exact match, recency decay (configurable half-life, default
off → 1.0 unless asked), validation weight, confidence weight. Formula documented in code;
never presented as calibrated probability.

## 4. Freshness (per-domain, configurable)

`FreshnessPolicy {domain, fresh_ms, aging_ms}` defaults: price/tick 60s/300s; intraday bar
15m/1h; daily bar 48h/7d; corporate-event 24h/7d; fundamentals 90d/180d; static (name/sector)
365d/730d; default 24h/7d. `classify(age_ms, domain)` → FRESH/AGING/STALE, missing
timestamp → UNKNOWN. Domain from record metadata (`domain` field, default `default`).
Freshness ≠ truth: stored separately from confidence/validation; old FACTs stay FACT.

## 5. Reuse decision (deterministic, LLM-advisory only)

`decide(request {subject, topic?, min_confidence?, evidence_threshold?})`:
- no candidates → RESEARCH
- candidates exist but below evidence/confidence bar → INSUFFICIENT
- ≥2 candidates, same subject+topic, different canonical content, both validated-looking → CONFLICT
- best candidate STALE (or superseded/invalidated marker) → REFRESH
- best candidate FRESH/AGING + validated + confidence ≥ min → REUSE
Order matters: CONFLICT beats REFRESH beats REUSE. Returns `{decision, basis, candidates}`.
LLM may explain; it cannot change the evidence set.

## 6. Research tasks + dedup

`ResearchTask {task_id, subject, objective, scope, requested_at, agent, status
(PENDING|RUNNING|COMPLETED|FAILED|SUPERSEDED), result_reference, knowledge_version}`.
Persisted as knowledge nodes (kind `Experiment`, id `task:<key>`) → versioned history.
`taskKey = norm(subject)|norm(objective)|norm(scope)` (lowercase, punctuation/whitespace
collapsed). `findSimilar` = exact key match (REUSE candidate) or token-Jaccard ≥ threshold
(default 0.5, configurable) over normalized bags (flagged heuristic). Freshness + status +
contradiction gates from §5 decide reuse. Expired (stale result) → REFRESH, never silent redo.

## 7. Invalidation (mark, never delete)

`invalidate({targets, cause, eventRef, actor})` appends evidence/agent memory markers
`{target, status: STALE|SUPERSEDED|CONTRADICTED|INVALIDATED, cause, event_ref}`; original
research nodes/memories untouched. Triggers: new relevant event, filing/earnings/corp-action,
market change, quality failure, source invalidation, contradiction, threshold breach.
`decide()` consults markers (STALE marker → REFRESH even if base record looks fresh).

## 8. Gaps

`gapReport(subject, topics: TopicRule[])` with `TopicRule {topic, entity_ids, memory_keys}`:
per topic → KNOWN (fresh, unmarked) / STALE (aging/stale or marked) / CONFLICTED /
MISSING (nothing) / UNKNOWN (no timestamp). Guides targeted research, never full redo.

## 9. Budget awareness

`budgetInfo(subject)` → `{estimated_effort (heuristic 1..5 + basis), evidence_count,
fresh_count, stale_count, research_history (tasks), missing: string[]}`. Orchestrator-grade
signal; no optimizer in Phase 4.

## 10. Market data (vendor-neutral, NSE = config)

Canonical `Bar/Quote` = `{instrument_id, exchange, market, segment, symbol, contract?,
ts (epoch ms), tz (IANA), ts_original, open/high/low/close?, price?, bid/ask?, volume?,
provider, source, retrieved_at, observed_at, data_version?}`. `normalizeBar/Quote(raw,
provider)` rejects ambiguous timestamps (no tz/offset → throw) and non-generic fields.
Quality `assess(record, ctx {now, lastTs?, seenIds?, refPrice?, peerQuotes?})` checks: missing
fields, invalid/future timestamp, duplicates, out-of-order, negative price/volume,
high<low (and open/close outside [low,high]), zero/invalid quantity, stale per policy,
jump vs ref (>x% → SUSPECT), peer disagreement (>y bps → SUSPECT). Verdicts VALID /
SUSPECT / QUARANTINED + reasons. Quarantine store keeps record + provenance + reasons;
promotion back to VALID only via explicit re-assess (tested impossible implicitly).
Provider interfaces only (no production ingestion): a deterministic `StubProvider` + fixture
feeds power tests/demo.

## 11. Events + integration loop

`MarketEvent {event_id, event_type (13 corp/macro types + custom), entity_refs,
instrument_ids, occurred_at, received_at, source, payload}`. Minimal deterministic path:
corporate-action record (split/dividend/bonus) → `corpActionToEvent` → `applyMarketEvent`
→ invalidate mapped targets (topic rules per event type, e.g. earnings → revenue/valuation
memories) → affected tasks become REFRESH. Validated market data → `observeMarket`
commits OBSERVATION node + provenance (`market-data` source_type) → memory. Full loop
proven in tests + `verify-memory.mjs`.

## 12. Agent + trading-experience schemas

Typed builders (required-field validated) producing put-memory payloads:
agent-memory `{agent, task_id, actions, sources, conclusions, confidence, failures, lessons,
knowledge_version}` (structured, never raw chat); trading-experience `{decision, context,
strategy, risk_state, execution, outcome, prediction, actual, error, lesson}` (foundation
only — no learning loop). Categories `agent` / `trading-experience` with owner ACL on agent
records (owner or `orchestrator` role reads; enforced in `retrieve`, tested).

## 13. Security / independence / resources

Secret-shaped content rejected at knowledge ingest (existing) + retrieval contexts pass
through `redact()` in `buildAgentContext` (tested: keys never reach agent context).
No gateway/broker/training/network imports in new packages (lint + source-scan tests).
Model-independence regression: knowledge+memory built under stub-A, gateway swapped to B
then discarded → identical retrieval; embedding version bump keeps old vectors addressable.
Perf: retrieval/dedup/quality/invalidation timed on 500-record fixtures with generous bounds
+ query-count assertions proving REUSE path is O(scans) vs research cost constant.

## 14. Tests (§28 matrix) + verification gates

Memory (7), reuse (5), dedup (4), invalidation (4), quality (8+ incl. each check class),
independence (3), security (3: injection, redaction, ACL), demo-agent loop (§33 four-stage),
perf bounds. Then `pnpm test`, `pytest`, `typecheck`, `lint` (new boundary rules),
`verify-sqlite/knowledge/sync/memory`, and `docs/audits/phase-4-audit.md` (12 audit points),
fix CRITICAL/HIGH, focused commits, final report. No Phase 5.
