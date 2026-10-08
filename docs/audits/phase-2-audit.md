# AURIX Phase 2 Audit Report — Knowledge Platform + Evidence/Provenance

**Scope:** Phase 2 implementation against Master Spec §§12–14, architecture v1.0.1 §§5/7/15,
`tasks/phase-2-plan.md`. Phase 1 regression required (no Phase 1 safety test deleted).
**Baseline:** `b593a49` + Phase 1 audit `5746c9b` (PASS).
**Method:** code re-read + repo-wide searches + full test execution. Test-green treated as
necessary but not sufficient; each §24 audit point re-proven against the implementation.

## 1. Audit points (§24) — verdicts

| # | Claim | Verdict + evidence |
|---|---|---|
| 1 | Knowledge cannot bypass validation | PASS — `commit()` throws unless proposal is VALIDATED; `applyOps` is private and reachable only via `commit`/`replay`; rejected proposals persist with reasons, never applied (lifecycle tests) |
| 2 | Agents cannot directly write the graph | PASS with note — all writes flow through propose/validate/commit; Python has zero writers (search-clean); in-process TS callers are bound by convention + lint (knowledge core forbids LLM/broker/training/network imports — lint extended and green). Research/data agents do not exist yet (Phase 4); their proposal-only access will be enforced then (O1) |
| 3 | LLM cannot become system-of-record | PASS — store imports no gateway/model code (source scan test); knowledge built under stub model-A, swapped to B, gateway discarded → identical query results (test) |
| 4 | Knowledge events append-only | PASS — `knowledge_events` receives only insert/get/query in src; zero update/delete call sites (verified by search). `update()` targets are limited to proposals lifecycle, fact-claim accrual, node current-pointer, edge expiry, version counter — all of which preserve history elsewhere |
| 5 | Provenance preserved | PASS — provenance rows insert-only, never updated; every commit writes one; `provenanceChain` returns time-ordered chains (tested) |
| 6 | History preserved | PASS — node updates append `node_versions` (CEO A→B keeps A, tested); edge changes expire+insert with `valid_until` (tested incl. `includeExpired` retrieval) |
| 7 | Conflicting evidence preserved | PASS — SUPPORTED_BY + CONTRADICTED_BY coexist as ACTIVE edges; both provenances retrievable separately (tested) |
| 8 | Secrets cannot enter knowledge | PASS — strong-pattern scan rejects proposals (`SECRET_DETECTED`, tested for api_key + private-key blocks); ordinary prose passes; export builder re-scans and `verifyExport` fails closed |
| 9 | Knowledge survives LLM replacement | PASS — see #3 |

## 2. Findings fixed during implementation (before this report)

- **F-P2-1 (MEDIUM, FIXED):** identical-content FACT re-assertion was rejected as DUPLICATE before
  corroboration could be evaluated, making two-source FACT promotion unreachable. Fixed: FACT
  assertions defer the duplicate check to the corroboration policy; commits skip redundant
  entity-version forks while still recording the corroborating event. Covered by
  fact-promotion tests (single-reject → corroborated-FACT, same-source-twice still rejects).
- **F-P2-2 (LOW, FIXED):** `store.ts` edit scarring (duplicated helper header, stray debug lines)
  broke the vitest transform. Fixed immediately; transform clean since.
- **F-P2-3 (LOW, FIXED):** test fixture used unsafe `Record → ProvenanceInput` casts, failing
  typecheck. Fixed by properly typing the fixture builder.

## 3. Severity classification

No CRITICAL or HIGH findings. MEDIUM: F-P2-1 (fixed + tested). LOW: F-P2-2, F-P2-3 (fixed).
INFORMATIONAL (non-blocking, deferred):
- O1: proposal-only agent access needs per-agent enforcement when research agents land (Phase 4).
- O2: FACT label upgrades for pre-existing INFERENCE nodes on later corroboration (promotion
  applies at commit time in Phase 2; upgrade path is Phase 4 debate work).
- O3: broker price-bound constraints not yet wired into any gate context (no orders exist in
  Phase 2; Phase 9 adapter work).
- O4: `dist/` build output is gitignored; proof scripts rebuild via `pnpm build`.

## 4. Regression + verification (executed)

- `pnpm test`: **22 files, 127 tests, all pass** (83 Phase 1 intact — counts per file ≥ baseline;
  db suite extended 3→4 by addition only; no Phase 1 test modified or deleted).
- `pnpm typecheck`: clean. `pnpm lint`: clean (incl. new knowledge-service boundary rules).
- `pytest`: **5 passed** (2 Phase 1 + 3 parity).
- `node scripts/verify-sqlite.mjs`: ok (Phase 1 DDL incl. new knowledge tables).
- `pnpm build` + `node scripts/verify-knowledge-sqlite.mjs`: real-SQLite propose/commit/query/
  export/replay all ok; cross-backend replay (SQLite → memory) snapshot-identical.
- Secret/broker/Python-boundary searches: clean (see §1 rows 8–9 and O-notes).

## 5. Final verdict

**PASS** — Phase 2 establishes the persistent, LLM-independent knowledge foundation per the
Master Spec and architecture. All HIGH/CRITICAL-class concerns are absent; every finding is
fixed and verified. The INFORMATIONAL items are documented above for later phases.
