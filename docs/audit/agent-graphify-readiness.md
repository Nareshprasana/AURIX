# AURIX Agent-Instruction + Graphify Readiness Report (verification-only, 2026-10-15)

- Branch: `main`, HEAD `bfd8a65`. No code/config/data/docs modified; no git ops.
- Initial status: `?? .opencode/`, `?? AGENTS.md`, `?? docs/audit/phase-4-acceptance-audit.md`, `?? graphify-out/`. Final: plus `?? docs/audit/agent-graphify-readiness.md` (this file).

## 1. AGENTS.md discovery: VERIFIED
- The actual coding agent (OpenCode) injects root `AGENTS.md` as developer instructions — observed directly: the full 270-line policy arrived in-context as `Instructions from: .../AURIX/AGENTS.md`, and references to it appear in tool output.
- Precedence observed: system prompt > developer (`AGENTS.md`) > user request. No inversion seen.
- Nested files: none (`**/AGENTS.md` = root only; no `CLAUDE.md`). Nothing directory-scoped to lose.
- Subdirectory probe (read-only subagent, services-python context): confirmed it sees `# AURIX Engineering Operating Policy (AGENTS.md)` and the research-only/sim-only rule; confirmed no nested overrides.
- `.opencode/plugins/graphify.js`: prepends an echo reminder about the graph on first shell use only. Does not ignore, override, or filter `AGENTS.md`. No conflicts.

## 2. Safety-instruction enforcement (newly reproduced vs inherited)
- Newly reproduced: `test_ai_api.py` 9/9 green (auth on all routes, malformed 400s, 429/413, audit redaction, no-broker-surface) with `-p no:cacheprovider`, tmp-only; `node scripts/lint.mjs` green; grep-confirmed zero secret/broker/promote tokens in `api.py`; manifest mtime check: 324/324 graph manifest entries unchanged, none missing.
- Source-verified (read-only): sim-only routing + kite-disabled throws (`engine.ts:209-212`, `broker-kite:32-34,91-96`), `allowLive` always false, risk veto-only, propose→validate→commit, lifecycle + retry discipline, tmp-only test isolation.
- Inherited (not re-executed): wfstress/governance suites, TS suites, research security tests, eod2-license-404 and NSE-unreachability facts.
- Cannot verify without prohibited action: refusal behavior with real broker credentials present; training isolation under a live run. Smallest safe future checks: sandboxed credential-present startup (factory must still throw); supervisor coexistence observation during an authorized training op. Neither run here.

## 3. Graphify status: PRESENT, verified fresh for built corpus, one known gap
- Artifacts exist: `graph.json` (2670 nodes), `GRAPH_REPORT.md`, `graph.html`, `manifest.json` (324 entries), `cost.json` (built 2026-10-13, 326 files).
- Generation procedure is documented in `AGENTS.md` §9 and the graphify skill (query/path/explain/export/benchmark all exercised live this audit).
- Freshness: proven for all 324 manifest entries (no mtime drift, none missing). Known gap: root `AGENTS.md` (empty at build, now 270 lines) was never extracted — recommend one-file `graphify --update` before the frontend milestone. Graph NOT regenerated here (not authorized as necessary).
- Discipline demonstrated: graph query located `TrainingAPIServer`/`TrainingAPIHandler` (`api.py:86,218`); contract confirmed in source, not assumed. Documented limits hold: missing graph path ≠ no code edge; degree ≠ coupling.

## 4. Frontend integration inventory (source: `services-python/aurix_ai/api.py`, `state.py:18-23`)
AVAILABLE_VERIFIED (bearer-on-loopback HTTP, tested):
- `GET /health` → `{status, version}`.
- `GET /v1/training/state` → full TrainingState (health, stage pipeline, epoch/total, loss/val-loss, checkpoint, heartbeat age, error, stdout/stderr refs, recovery_state, last_outcome).
- `GET /v1/training/events?last=N` → recent run events.
- `POST /v1/training/start` `{datasets?, interval?}` → supervised start (spawns real supervisor — frontend wiring needs explicit scoping).
- `POST /v1/training/stop` `{timeout?}` → graceful stop summary.
AVAILABLE_UNVERIFIED (CLI-only, no HTTP contract, not re-verified here):
- `auto-status`/`auto-state`/`auto-logs`, `registry --db active`, `research-cycle --dry-run`, dataset `quality.json`/manifests on disk.
MISSING (no route; needs backend change if frontend requires it):
- Experiment/registry history listing; dataset catalog + quality views; governance/decision records (`governance.json`, `eval.json`); per-experiment events/retry; research hypotheses/questions; portfolio/risk snapshots; backtest/walk-forward/stress artifacts; knowledge/research refs.
BLOCKED (never via frontend without separate authorization):
- Live execution, broker account views/credentials, real-market retraining beyond supervised start, any promotion/bypass action.

## 5. Checks performed and results
- `git status`/`rev-parse`/history read; full `AGENTS.md` read; `.opencode/plugins/graphify.js` read; nested-file globs; manifest mtime audit; `api.py` surface grep; `state.py` schema read; pytest `test_ai_api.py` (9 passed); `lint.mjs` (green); graphify `query` + prior `path`/`explain`/`benchmark`; subdirectory subagent probe. No training, backtests, GPU/LLM probes, broker, live, dataset, or git mutations.

## Recommendation
Agent instruction loading and safety enforcement are verified for routine work; Graphify is usable with the one-file update noted. Backend is ready for **read-only local frontend integration** against the five verified routes. Any start/stop wiring, missing-interface additions, or real-data operations require explicit scoped authorization first.
