# Cumulative Phase 1–5 Audit Plan

Target: current HEAD (`f3308b2` + `7666708` Phase 5). No Phase 6. Minimal fixes only
for audit findings (documented, tested, committed separately where appropriate).

## Audit dimensions (§4 invariants A–H)

- A. LLM independence — gateway-only boundary; model swap/removal survival; versioned embeddings coexistence; research usable model-down.
- B. Risk independence — LLM/research/knowledge/memory/strategy cannot reach Risk→Gate→Execution; deterministic controls; import-direction proof.
- C. Training isolation — no Phase 1–5 path touches future training artifacts/datasets/checkpoints; architecture reserves isolation.
- D. Evidence preservation — provenance/source/timestamp/methodology/evidence/confidence/validation/truth/contradictions/history survive Data→Research→Knowledge→Memory; no silent overwrites.
- E. Versioning — knowledge/evidence/memory/tasks/embeddings/packages/schemas/config/models reconstructable.
- F. Broker reconciliation — execution→broker→authoritative→reconcile boundary intact; no fabrication paths from research/memory/knowledge/sync.
- G. Safe failure — UNKNOWN/INSUFFICIENT/CONFLICT/QUARANTINED/stale/missing/model-down/broker-down/sync-fail/corrupt/duplicate/replay/partial/restart/DB-recovery all fail safe.
- H. Autonomous-live boundary — YAML/env alone cannot enable live; promotion + operator + safety gates required.

## Cross-cutting reviews

- Data flow (§5): contract agreement, stable IDs, meaningful timestamps, resolvable refs, provenance survival, no confidence→truth / stale→current / quarantine→valid drift, invalidation reach, consumer correctness.
- Memory↔Knowledge (§6): no second system-of-record; authority respected; refs valid; invalidation propagates; contradictions visible; history not promoted; stale≠fresh; explainable reproducible reuse (all five outcomes).
- Events↔Memory (§7): earnings/mgmt-change/corp-action examples; missing/excessive/wrong-linkage checks; no stale reuse; no event duplication/replay faults.
- Sync↔Knowledge↔Memory (§8): transport-only Syncthing; no live-DB sync; auth+encryption; idempotent replay; causality; divergence/conflict preservation; memory↔knowledge referential soundness post-merge. Scenarios A–D live in `verify-sync-sqlite.mjs` + unit suites.
- Research↔Memory (§9): loop integrity; freshness gates; INSUFFICIENT honesty; quarantine exclusion; visible contradictions; provenance-backed outputs; no unsupported FACTs; deterministic selection; model-replacement survival.
- Data quality (§10): raw→VALID/SUSPECT/QUARANTINED; reasons persisted; downstream respect; stale≠invalid, missing≠quarantined; partials explicit. Malformed/incomplete/stale/contradictory/corrupt probes.
- LLM security (§11): repo-wide secret/shell/eval/direct-Ollama/broker-SDK/risk-bypass search; gateway-only proof; sanitized context proof.
- Boundaries (§12): dependency direction per package; safety-path purity; research incapability (broker/execution/live/risk); knowledge-service write authority; gateway exclusivity; execution exclusivity; no cycles/hidden coupling/dual writers/bypasses.
- Persistence/recovery (§13): restart semantics per store; interruption/partial/duplicate/replay/failed-import/corrupt/restart coverage; determinism.
- Idempotency (§14): keys/identity/replay/duplicates per append path (events, tasks, memories, imports, evidence, event-intel, ingestion).
- Authority matrix (§15): per agent/service Read/Write/Authority/Forbidden table.
- Threat model (§16) + prompt injection (§17, malicious fixtures) + config security (§18) + observability (§19) + determinism (§20) + resources (§21) + test integrity (§22) + git integrity (§23).

## Verification scenarios (§24, executed — not assumed)

New `scripts/verify-cumulative.mjs` on real SQLite proves end-to-end: (1) reuse,
(2) event refresh, (3) bad-data refusal, (4) contradiction preservation,
(5) device divergence merge, (6) device conflict + resolution, (7) model replacement,
(8) LLM failure safety, (9) prompt injection inertness, (10) research↛execution boundary,
(11) secret boundary, (12) replay idempotency (event/package/research/event-intel).

## Gates + report

`pnpm test`, `pytest`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, all six verify scripts
(sqlite, knowledge, sync, memory, research, cumulative). Report
`docs/audits/cumulative-phase-1-5-audit.md` with the 27 mandated sections, severity
counts, fixed/deferred lists. Verdict PASS / PASS WITH CONDITIONS / FAIL per §28.
Single audit commit; no Phase 6.
