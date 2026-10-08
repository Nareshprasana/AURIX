# AURIX Phase 5 TODO

From `tasks/phase-5-plan.md`. Phases 1–4 suites (216 TS + 10 py) must stay green.

## Design
- [x] `tasks/phase-5-plan.md`
- [x] `tasks/phase-5-todo.md` (this file)

## Contracts (`packages/contracts`, additive)
- [ ] ResearchStatus, EvidenceItem, ResearchObservation, AgentResult, ResearchResultBundle
- [ ] SourceQualityPolicy type + topic→agent routing map type

## Agents (`apps/research-agents`, TS, deterministic cores)
- [ ] Agent interface + AgentContext + Interpreter (local, gateway-free imports)
- [ ] Fundamental (metrics, growth, periods, contradictions, no invented data)
- [ ] Technical (SMA/trend/ROC/volatility/S-R/drawdown, VALID-only, quality recorded)
- [ ] Valuation (ratios, assumptions, uncertainty, calc version, gaps listed)
- [ ] Sentiment (lexicon, near-duplicate grouping, aggregate INFERENCE)
- [ ] Macro (indicators, periods, revisions versioned)
- [ ] EventIntelligence (event nodes, dependency-scoped invalidation)

## Orchestrator
- [ ] Memory-first routing (REUSE/REFRESH/RESEARCH/CONFLICT/INSUFFICIENT)
- [ ] Selective agent execution + per-agent timeout (PARTIAL on failure)
- [ ] Cross-agent contradiction pass + evidence bundle assembly
- [ ] Knowledge commits via store only + task completion + agent-memory records
- [ ] affectedTasks(event) dependency-scoped refresh targeting

## Support
- [ ] Source-quality policy (configurable authority, duplicate Jaccard)
- [ ] Research context builder (minimal, redacted, ACL)

## Python parity
- [ ] Status vocab + output-contract required-fields mirror + tests

## Proof script
- [ ] `scripts/verify-research.mjs` (§38/§26 loop on real SQLite)

## Tests (§33 matrix)
- [ ] Orchestrator 5, fundamental 5, technical 4+, valuation 4, sentiment 4, macro 4
- [ ] Events 5, invalidation scoping 4, knowledge path 5, security 3, failure 5, no-trade 2

## Audit + verify + commit
- [x] `pnpm test`, `pytest`, `typecheck`, `lint`, `build`, all five verify scripts
- [x] `docs/audits/phase-5-audit.md` (14 points, severity)
- [x] Fix CRITICAL/HIGH; focused commits; final report (no Phase 6)
