# Cumulative Phase 1–5 Audit TODO

## Plan
- [x] `tasks/cumulative-phase-1-5-audit-plan.md`
- [x] `tasks/cumulative-phase-1-5-audit-todo.md` (this file)

## Evidence gathering
- [x] Repo-wide searches: secrets, shell/eval, direct Ollama, broker SDK, risk bypass
- [x] Dependency-direction verification (imports per safety/research/knowledge/gateway/execution boundary)
- [x] Config security review (defaults, env overlay, promotion gate)
- [x] Authority matrix compilation (§15)

## Verification scenarios (§24)
- [x] `scripts/verify-cumulative.mjs` implementing scenarios 1–12 on real SQLite
- [x] Prompt-injection fixtures executed, inertness proven

## Full battery
- [x] `pnpm test` (267), `pytest` (13), `typecheck`, `lint`, `build`
- [x] All six verify scripts incl. new cumulative script

## Report + commit
- [x] `docs/audits/cumulative-phase-1-5-audit.md` (27 sections, severity, fixed/deferred)
- [x] Threat model (§16) inside report
- [x] Minimal fixes (if any): documented, tested, committed separately
- [x] Single audit commit; final response per §29; no Phase 6
