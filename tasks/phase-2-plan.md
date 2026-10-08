# AURIX Phase 2 Plan — Knowledge Platform + Evidence/Provenance

Implements Master Spec §§12–14 (knowledge, evidence, memory) and architecture v1.0.1 §§5, 7, 15.
Phase 1 baseline: `b593a49` + audit `5746c9b` (verdict PASS). No Phase 1 safety test may be
deleted; all must keep passing.

Principle: `LLM ≠ Knowledge`. The store is deterministic TypeScript over a table
abstraction; SQLite remains the approved persistence (DDL + adapter + real-SQLite proof),
memory adapter drives vitest (same precedent as Phase 1 event-bus).

## 1. Knowledge model

- Entity kinds (contracts): Company, Security, Instrument, Exchange, Sector, Industry,
  Commodity, Currency, EconomicIndicator, MacroEvent, NewsEvent, FinancialMetric, Strategy,
  Model, Prediction, Trade, Order, Portfolio, RiskEvent, Agent, Observation, Experiment.
- Stable IDs supplied by proposer (`<kind-lower>:<key>`, e.g. `company:RELIANCE`);
  extensible `data` record; `version` counter + `status` per entity row.
- Relationship types: AFFECTS, CORRELATED_WITH, DEPENDS_ON, COMPETES_WITH, CAUSED, PREDICTED,
  OBSERVED, TRADED, GENERATED_SIGNAL, SUPPORTED_BY, CONTRADICTED_BY, LEARNED_FROM, DERIVED_FROM.
- Edges carry: id, source, target, type, created_at, valid_from, valid_until (null = current),
  confidence, provenance ref, version, status (ACTIVE/EXPIRED). Change = expire + insert, never overwrite.

## 2. Evidence model / 3. Provenance model

- Provenance per assertion: source, source_type (`exchange-filing | regulator |
  audited-statement | press | market-data | llm | agent | human | other`), source_identifier,
  observed_at, ingested_at, agent, model (+ prompt/version where LLM-derived), evidence_refs,
  confidence (0..1), validation_state.
- Every FACT/OBSERVATION/INFERENCE/HYPOTHESIS/PREDICTION commit requires complete provenance;
  UNKNOWN carries provenance-optional but versioned.

## 4. Knowledge events

- Flow: Proposal → Validation → Knowledge Event → Knowledge Store (§7 architecture).
- Deterministic event id = `ke-<seq>-<cyrb53(canonical(proposal))>`; commit is idempotent:
  existing event id ⇒ return prior event, no re-apply (duplicate events never duplicate knowledge).
- Events ordered by `knowledge_version` (monotonic int); payload sufficient for replay/audit/
  sync/version-reconstruction/debug.

## 5. Knowledge versioning

- `schema_version` (`graph-v1`), `knowledge_version` (per committed event), `entity_version`
  (per-entity counter), `event_version` (= knowledge_version after commit).
- `node_versions` retains every entity snapshot (CEO A→B keeps A). Edges version via
  expire+insert. No silent overwrites; no deletes (status transitions only).

## 6. Memory model

- One `memories` table + six category helpers: semantic, episodic, trading-experience,
  strategy, agent, evidence. `putMemory/getMemories` typed by category.
- Embeddings: `embeddings` table (id, document_id, model, model_version, dim, vector,
  metadata, created_at, knowledge_version). New embedding model ⇒ new rows; old rows retained.

## 7. Confidence model

- Confidence is a recorded 0..1 claim, never a calibrated probability (Master Spec non-goal).
  Stored with provenance; aggregation/debate use is Phase 4+. Range-validated; LLM default 0.5.

## 8. Validation lifecycle

- Proposal states: PROPOSED → VALIDATING → VALIDATED → (commit) | REJECTED (reasons kept).
- `proposals` table persists every state for audit. Schema/label/provenance/secret checks run
  before policy checks; failures REJECT with reasons, never silent-drop.
- FACT promotion (Phase 2 policy): ≥2 independent sources (distinct source_identifier, or
  distinct agent with non-LLM source_type), OR one authoritative source_type
  (`exchange-filing|regulator|audited-statement`). Single LLM/agent claim ⇒ stays
  INFERENCE/HYPOTHESIS/PREDICTION, never FACT. LLM-derived input defaults to non-FACT
  (caller declares assertion; service downgrades bare LLM FACT claims to INFERENCE unless
  corroboration is present).

## 9. Knowledge ingestion API (`KnowledgeService` facade, knowledge-service owns all writes)

- `propose(input) → proposal` (id assigned, PROPOSED, persisted)
- `validate(id) → VALIDATED | REJECTED` (runs full policy)
- `commit(id) → KnowledgeEvent` (idempotent; applies node/edge/memory/provenance writes,
  bumps knowledge/entity versions, emits event)
- `proposeValidateCommit(input)` convenience for tests/callers (same steps, same guarantees)
- Agents submit proposals; no direct graph mutation (no table access outside the service).

## 10. Knowledge query API (deterministic, no NL agent)

- `getEntity`, `getEdges(entity, {direction?, type?, includeExpired?})`, `neighbors(entity, type)`,
  `supportingEvidence(ref)`, `contradictingEvidence(ref)`, `entityHistory(id)`,
  `knowledgeVersion()`, `eventsAfter(n)`, `provenanceChain(ref)`, `queryMemories(category, key?)`.

## 11. Graph storage

- SQLite DDL extended (db-bootstrap): nodes (+version/status), node_versions, edges
  (+valid_from/valid_until/confidence/status/version), proposals, embeddings; existing
  knowledge_events/provenance/memories/versions retained.
- `KnowledgeTables` interface (insert/get/query/update) with `MemoryTables` (vitest) and
  `SqliteTables` (node:sqlite; exercised by a plain-node proof script, same pattern as Phase 1).

## 12. Semantic memory interface

- `putEmbedding({document_id, model, model_version, vector, metadata})`,
  `getEmbeddings(document_id)`, `getEmbedding(id)`; model/version-keyed, history retained.

## 13. Snapshot/export interface (`.akpkg` foundation; encryption/sync deferred to Phase 11)

- `buildExport(store)` → deterministic package: manifest (schema/knowledge versions, counts,
  created_by/at, min_compatible), snapshot (nodes+edges canonical order), events (version order),
  provenance, memories (+embeddings metadata+vectors), checksums (sha256 over canonical JSON).
- `verifyExport(pkg)` recomputes checksums. Secrets rejected at ingest; export additionally
  scanned; no secrets ever included.

## 14. LLM independence

- Store never imports gateway/model code. Tests: build knowledge via stub gateway model A →
  swap to model B / discard gateway → identical query results; provider removal changes nothing.

## 15. Tests (new suites; Phase 1 suites untouched)

- Entity (5), relationships (5 incl. conflicting), provenance (6), events (6 incl. replay +
  version reconstruction + store rebuild), validation lifecycle (4), FACT promotion (single LLM
  claim ≠ FACT; corroborated ⇒ FACT), LLM independence (2), security/redaction (3),
  export determinism/verify (3), memory layers (6 categories), versions/history (CEO A→B).

## 16. Failure handling

- Invalid proposal ⇒ REJECT with reasons (persisted). Duplicate event id ⇒ idempotent return.
- Conflicting entity create ⇒ DUPLICATE reject (use update flow). Store methods throw typed
  `KnowledgeError(reason)`; callers never see partial applies (commit validates fully first).
- Unknown/invalid ⇒ no write (fail-closed, same posture as Phase 1 safety path).

## 17. Non-goals (later phases)

Live trading, brokers/Kite, market-data ingestion, research agents, strategy generation,
training, learning loop, device sync, NL query, vector-DB backends, heavy embedding models.

## 18. Verification gates

`pnpm test` (Phase 1 83 + new suites), `pytest`, `pnpm typecheck`, `pnpm lint`
(extend boundary rules: knowledge-service must not import gateway/broker/training;
Python must not gain graph writers), `node scripts/verify-sqlite.mjs` +
new `node scripts/verify-knowledge-sqlite.mjs`, then `docs/audits/phase-2-audit.md`.
