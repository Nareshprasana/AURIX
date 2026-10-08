# AURIX Phase 4 TODO

From `tasks/phase-4-plan.md`. Phases 1–3 suites (166 TS + 8 py) must stay green.

## Design
- [x] `tasks/phase-4-plan.md`
- [x] `tasks/phase-4-todo.md` (this file)

## Market data (`packages/market-data`, pure TS, zero node imports)
- [ ] Canonical types + provider interfaces (Market/Quote/Bar/CorpAction/Instrument)
- [ ] Normalization (explicit tz, ambiguous → throw, vendor-neutral)
- [ ] Quality engine (VALID/SUSPECT/QUARANTINED + full check list)
- [ ] Quarantine store (provenance + reasons retained)
- [ ] Per-domain freshness policies + state exposure
- [ ] Event foundation (13 types + corpActionToEvent + StubProvider)
- [ ] Tests: normalization, every check class, quarantine, freshness, neutrality

## Memory manager (`apps/memory-manager`)
- [ ] Retrieval with filters + retrieval metadata
- [ ] Relevance (labeled heuristic weights)
- [ ] Freshness policies + classify (FRESH/AGING/STALE/UNKNOWN)
- [ ] Reuse decision (REUSE/REFRESH/RESEARCH/CONFLICT/INSUFFICIENT, ordered)
- [ ] ResearchTask registry (Experiment nodes) + normalized key + Jaccard dedup
- [ ] Invalidation markers (STALE/SUPERSEDED/CONTRADICTED/INVALIDATED)
- [ ] Gap reports (KNOWN/UNKNOWN/STALE/CONFLICTED/MISSING)
- [ ] Budget info (effort heuristic + evidence counts + history)
- [ ] Agent context builder (redact + owner ACL) + typed agent/trading-experience builders
- [ ] Integration: observeMarket + applyMarketEvent loops
- [ ] Tests: memory 7, reuse 5, dedup 4, invalidation 4, independence 3, security 3, demo loop, perf

## Python parity
- [ ] Freshness + quality-verdict mirrors + tests

## Proof script
- [ ] `scripts/verify-memory.mjs` (§33 four-stage demo on real SQLite + timings)

## Audit + verify + commit
- [x] `pnpm test`, `pytest`, `typecheck`, `lint`, all four verify scripts
- [x] `docs/audits/phase-4-audit.md` (12 points, severity)
- [x] Focused commits; final report (no Phase 5)
