# AURIX Phase 2 TODO

From `tasks/phase-2-plan.md`. Phase 1 suites (83 TS + 2 py) must stay green untouched.

## Design (done before code)
- [x] `tasks/phase-2-plan.md` (topics §1–§18)
- [x] `tasks/phase-2-todo.md` (this file)

## Contracts
- [x] Entity kinds (22) + relationship types (13) + proposal/lifecycle/provenance/memory/embedding/export types
- [x] Test: vocabularies complete; no venue branches

## Store core (apps/knowledge-service)
- [x] `tables.ts`: KnowledgeTables interface + MemoryTables
- [x] `sqlite.ts`: SqliteTables over node:sqlite (excluded from vitest imports)
- [x] `cyrb53` canonical-hash + stable stringify helpers
- [x] Validation lifecycle: propose/validate/commit + proposals table + FACT corroboration policy
- [x] Secret scan (reject) on ingest
- [x] Entity versioning: nodes + node_versions (no overwrite); edge expire+insert
- [x] Conflicting evidence: SUPPORTED_BY / CONTRADICTED_BY preserved side-by-side
- [x] Memory layers: 6 categories + embeddings (model-versioned)
- [x] Query API: entity/edges/neighbors/evidence/history/version/events/provenance/memories
- [x] Replay: rebuild store from events; canonical snapshot compare
- [x] Export: deterministic `.akpkg` builder + verifier (sha256, no secrets)

## DDL (packages/db-bootstrap)
- [x] Extend KNOWLEDGE_DDL: nodes/status/version cols, node_versions, edge validity cols, proposals, embeddings, poll index

## Python parity (services-python)
- [x] `aurix_py/knowledge.py`: labels, lifecycle states, corroboration rule mirror (no writers)
- [x] Tests: parity with TS policy

## Tests (new suites)
- [x] Entity 5, relationships 6, provenance 6, events 4 + lifecycle 4, FACT promotion 5, LLM independence 2, security 3, export 3, memories 5, history/version covered
- [x] `scripts/verify-knowledge-sqlite.mjs`: real-SQLite propose/commit/query/replay proof

## Audit + verify + commit
- [x] `pnpm test`, `pytest`, `typecheck`, `lint`, both sqlite scripts
- [x] `docs/audits/phase-2-audit.md` (verdict PASS)
- [ ] Focused Phase 2 commits; final report (no Phase 3)
