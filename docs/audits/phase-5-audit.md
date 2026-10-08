# AURIX Phase 5 Audit Report — Research & Event Intelligence

**Scope:** Phase 5 implementation against the Phase 5 brief (§§1–40), Master Spec
research/intelligence requirements, architecture v1.0.1, `tasks/phase-5-plan.md` (§1–§10).
Phases 1–4 regression required.
**Baseline:** Phase 1 `b593a49`+`5746c9b`, Phase 2 `7a62677`+`503cd85`,
Phase 3 `caf2386`+`d199bc7`, Phase 4 `5e19636`+`b6469a8` (all PASS).
**Method:** code re-read + repo-wide searches + full test execution. Test-green treated as
necessary but not sufficient; each §37 point re-proven against the implementation.

## 1. Fourteen audit points (§37)

| # | Claim | Verdict + evidence |
|---|---|---|
| 1 | Memory-first research | PASS — `investigate` always runs `memory.decide` before any agent; REUSE returns cached bundles with zero agent runs and zero LLM calls (tested); agents cannot be invoked except through the orchestrator path |
| 2 | Research deduplication | PASS — exact-key registry dedup (pending/running/fresh-completed) + Jaccard similar-task search; expired results spawn versioned successors; repeated identical asks register once (tested) |
| 3 | Freshness handling | PASS — stale candidates force REFRESH (decision ordering fixed during implementation, F-P5-3); per-domain bands reused from Phase 4; event markers dominate fresh-looking records |
| 4 | Event-driven invalidation | PASS — `refreshForEvent` = `applyMarketEvent` markers + `affectedTasks` dependency intersection; only intersecting tasks rerun (TCS refreshed, INFY untouched — tested); unrelated events change nothing |
| 5 | Evidence provenance | PASS — every observation carries methodology + inputs_ref + quality; bundles cite evidence ids (or own observations + task id when agent evidence is absent — never empty, store policy enforced); task/agent-memory/provenance chains reconstruct the why (tested) |
| 6 | Contradiction preservation | PASS — three layers: agent-level (same metric+period divergence with stated possible causes), cross-agent metric pass, memory CONFLICT; conflicted bundles commit as CONFLICTED with both chains (tested at each layer) |
| 7 | Source provenance | PASS — evidence items carry source/type/identifier/timestamps; bundle aggregates `sources[]`; low-authority and secret-bearing items excluded by id in `sources_excluded` (tested) |
| 8 | Data-quality enforcement | PASS — double gate (context assesses + agent re-assesses, VALID-only); quarantined-only input → DATA_QUARANTINED with zero observations; quarantined data can never become a VALID observation (tested both layers) |
| 9 | LLM isolation | PASS — agents depend only on the local `Interpreter` interface; zero gateway/broker/risk/execution/portfolio imports in research src (lint + source-scan tests); interpreter output labeled INFERENCE with model provenance, consulted only after deterministic core; secrets triple-gated (intake scan + context redaction + gateway redaction, end-to-end test) |
| 10 | Knowledge-service-only writes | PASS — agents contain zero knowledge-service/store references (verified by search); all commits flow through orchestrator `proposeValidateCommit`; agent FACT suggestions coerced to INFERENCE with explicit flag (tested) |
| 11 | No trading decisions | PASS — output contract has no order/position/leverage/capital fields (type-level + Python mirror + tests); agent corpora scanned for order-construction identifiers (absent); technical conclusions explicitly disclaim direction |
| 12 | No broker access | PASS — same scans; no Kite/credentials/orders/positions/funds/execution references in research code |
| 13 | No training | PASS — no training code, references, or infrastructure changes (verified by search) |
| 14 | Resource efficiency | PASS — selective agent execution (single-agent runs asserted), interpreter optional and lazy, no polling scheduler (event-driven contracts only), REUSE path performs zero agent/LLM work; proof timings show reuse (1ms) ≪ research (29ms) |

## 2. Findings fixed during implementation (before this report)

- **F-P5-1 (MEDIUM, FIXED):** bundle and agent proposal commits carried empty
  `evidence_refs` whenever agents returned no evidence items, tripping store policy
  (`REJECTED: provenance requires evidence_refs`) across most orchestrator flows. Fixed:
  bundles cite own observations + task id as fallback; agent proposals fall back to their
  observation ids + task id, else an explicit `skipped:` marker. Evidence discipline holds
  with no silent drops.
- **F-P5-2 (MEDIUM, FIXED):** second identical requests never reached REUSE — research
  outputs (bundle/task/agent-memory nodes) carry no numeric confidence and agent memories
  lacked entity linkage, so the confidence gate forced INSUFFICIENT. Fixed at the producer:
  agent memories now record entity/topic, bundle nodes surface recorded confidence (read,
  never invented). Memory-level REUSE/REFRESH now closes the loop (proven by tests).
- **F-P5-3 (MEDIUM, FIXED):** `decide` evaluated weak-evidence (INSUFFICIENT) before
  staleness, so stale research reported INSUFFICIENT instead of REFRESH. Fixed ordering:
  contradiction → markers → staleness → sufficiency → reuse. All Phase 4 decision tests
  still pass unchanged.
- **F-P5-4 (LOW, FIXED):** agent routing matched only fixed topic keywords, so injected
  custom agents (timeout/throwing/FACT-coercion tests) could never be selected. Fixed:
  explicit agent-id tokens also select (documented extension point, default six unaffected —
  selective-execution test still asserts exactly `['technical']`).
- **F-P5-5 (LOW, FIXED):** context pre-filtering ate quality signals (all-excluded bars
  looked like no-data). Fixed: agents distinguish DATA_QUARANTINED from INSUFFICIENT_DATA
  via quality notes; direct-agent and orchestrated paths both tested.
- **Process notes:** three edit-scarring incidents (doubled `export`, truncated test tail,
  wrong relative import depth `./` vs `../`) broke transforms; all repaired, transforms
  clean. One exploratory `python3 -c` probe hit a missing interpreter alias — no effect.

## 3. Severity classification

No CRITICAL or HIGH findings. MEDIUM: F-P5-1, F-P5-2, F-P5-3 (fixed + tested). LOW:
F-P5-4, F-P5-5 (fixed). INFORMATIONAL (non-blocking):
- O1: memory contradiction grouping compares same-shape (topic+metric+keyset) records;
  cross-shape claim alignment (node FACT vs memory note) is Phase 6+ work; cross-agent
  metric pass covers agent outputs today.
- O2: superseded runs are excluded from live decisions via task linkage (agent memories by
  `task_id`, bundle/proposal nodes by `data.task_id`); pre-Phase-5 memories without task
  linkage are unaffected.
- O3: orchestrator timeout uses wall-clock `Promise.race`; hanging-agent promises stay
  pending (never reject) so no unhandled rejections.
- O4: valuation PARTIAL threshold (exactly 1 ratio) and ±20% bands are stated heuristics,
  not calibrated uncertainty.

## 4. Regression + verification (executed)

- `pnpm test`: **49 files, 267 tests, all pass** (216 prior intact — zero prior test files
  modified or deleted; `git status` confirms scope is the research app + wiring only).
- `pnpm typecheck`: clean. `pnpm lint`: clean (new research boundary rules executing).
- `pytest`: **13 passed** (10 prior + 3 research parity).
- `pnpm build` clean; all five verify scripts ok, including new `verify-research`
  (§38 loop RESEARCH→REUSE→REFRESH→QUARANTINE-BLOCK on real SQLite + broker/risk/
  execution import scan).
- Searches: agents import no store/broker/order/fetch/training code; research tree has no
  training references; market types correctly sourced from `@aurix/market-data`.

## 5. Final verdict

**PASS** — Phase 5 delivers cumulative, evidence-driven research: memory-first selective
orchestration across six deterministic specialist capabilities, provenance-backed
observations with preserved contradictions, dependency-scoped event refresh, fail-safe
quality gating, FACT discipline, secret-safe LLM isolation, and zero trade/broker/training
surface. All findings fixed and verified.
