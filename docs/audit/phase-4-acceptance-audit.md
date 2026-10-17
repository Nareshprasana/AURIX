# Phase-4 Backend Acceptance Audit (read-only, 2026-10-13)

- Branch: `main`. Starting HEAD = ending HEAD = `bfd8a65` (parent `a3333a6`, baseline `69a9251`).
- Initial `git status --short`: clean. Final: clean except this new report (untracked).
- Scope: accept/reject U1, U2, U3, U4, U7, U8, U9 against repo state at `bfd8a65`.
  No code, config, data, or docs modified by this audit (one temp read-only
  copy of the old spec was staged in `%TEMP%\opencode` and removed afterwards).
- Skill applied: `code-review-and-quality` (five-axis review of the Phase-4 diff).

## Acceptance matrix

### U1 — Master Spec + regulatory seed: PASS
- `docs/audit/master-spec-reconstruction.md:1-17`: v0.2 records approval status,
  version history, and exactly the three approved amendments (R11 floors,
  R7 decided cut, Laya deferred). States NOT fully authoritative.
- R1–R15 headers byte-identical to v0.1 (verified old-vs-new header lists);
  only R11 (`master-spec-reconstruction.md:72-84`) and R7 (decided-cut note)
  changed per amendment. UNRESOLVED section (`:105+`) keeps all ten Us explicit.
- `config/regulatory-seed.v1.json`: version + `as_of: 2026-10-13` +
  per-release cadence + `rules: []` with honest empty-coverage disclaimer.
  Zero invented rules. Empty seed → UNKNOWN proven by
  `packages/market-data/test/regulatory-seed.test.ts` (newly reproduced, 3/3 green).

### U2 — NSE holiday calendar: PASS (mechanics) / BLOCKED (list acquisition)
- `packages/strategy/src/costs.ts:118`: `TradingCalendar.weekdays` still takes
  explicit lists only; grep finds no vendored holiday dates anywhere in `packages/`.
- `packages/strategy/test/costs.test.ts:45-52`: holiday exclusion uses a labeled
  fixture (`2024-01-02`, not claimed as a real NSE holiday) — newly reproduced green.
- Blocked claim (NSE publication unreachable, no dates invented) inherited from
  Phase-4 evidence; NOT re-fetched per audit exclusions. Re-entry documented
  in the spec (`master-spec-reconstruction.md:109-113`).

### U3 — Licensing + universe mapping: PASS (blocked honestly, no expansion)
- License fact (no `eod2_data` LICENSE; EOD2-project GPL-3.0 covers code, not
  NSE-sourced data) inherited, recorded in `docs/history-data.md` licensing section.
- No ISIN join/universe mapping in `services-python/aurix_ai` (grep for `isin|ISIN`
  matches only `isinstance`; only pre-existing ISIN seed in `config/instruments.yaml:8`).
  No new data fetched. U3 correctly remains deferred.

### U4 — Adjusted-price default: PASS
- `services-python/aurix_ai/cli.py` parser: `history-build --provider` defaults
  `eod2`; `history-fetch` intentionally retains `tej` (raw-archive tool).
- Manifest chain intact: `_cmd_history_build` records `adjustment_policy` +
  `source`; `_auto_train_impl` adds denormalized `price_basis`/`data_source`
  without touching `experiment_id` inputs (ID stability preserved).
- `dataset_version_id` hashes spec only — raw/adjusted builds require distinct
  `--id` (documented convention); same-spec collisions refuse with
  `DATASET_CORRUPT` (`datasets.py:167-170`), never mix. Proven by
  `test_history_build_defaults_to_adjusted_source` and
  `test_write_dataset_records_basis_and_keeps_stable_ids` (newly reproduced green).
- No dataset rebuilds, no proof-metric recomputation in the Phase-4 diff.

### U7 — Research security controls: PASS
- `node scripts/lint.mjs`: green (newly reproduced).
- `apps/research-agents/test/security.test.ts`: 3/3 green (newly reproduced).
- `docs/audit/research-connectors-decision.md` unchanged; no connectors,
  scraping, or credentials added in the Phase-4 diff.

### U8 — Governance floors: PASS (with noted blocker, no invented thresholds)
- `config/ai-policy.v1.yaml:69-96`: floors 0.01 / 0.0 / 10.0 recorded as
  promotion gates with re-calibration trigger and explicit Sharpe-zero
  non-profitability disclaimer; statistical min-windows marked UNSPECIFIED.
- `orchestrate.py:485-541` (`_extended_gate`): infra errors raise
  BACKTEST_FAILED; malformed numerics raise BACKTEST_FAILED (FAILED, retryable);
  vacuous (`windows<1`) and breached gates return False (REJECTED).
  `govern()` persists `policy_version` + threshold snapshot in every
  `governance.json` (`orchestrate.py:569+`).
- No `min_windows` (or any statistical threshold) in policy or code — the
  pre-existing draft invention was removed before commit. Verified by grep.
- All four required demonstrations newly reproduced green in
  `tests/test_ai_wfstress.py`: rigged-winner→REJECTED, runner-raise→FAILED
  (not REJECTED), malformed/vacuous→never-VALIDATED, all-pass→VALIDATED with
  policy audit fields. No VALIDATED→profitability/live language anywhere.

### U9 — Local API hardening: PASS
- `api.py:133-152` (`_int_param`): bools, non-integral floats, non-numeric
  text, lists/dicts, out-of-range → controlled 400s before any train/stop call.
- Routes unchanged (exactly the 5 pre-existing routes, `api.py:158-212`);
  `_guard()` on every route; constructor refuses non-loopback + missing/short
  token (`api.py:216+`); 60/min bucket; 64 KiB cap; audit pops
  token/authorization (`api.py:49-57`).
- `tests/test_ai_api.py` newly reproduced green (8/8): auth-everywhere,
  malformed interval/timeout 400s, rate-limit 429, body-cap 413, audit
  redaction, no-broker-surface, 8-way parallel serialized-but-correct.
- Single-threaded serialization documented as operational, not security
  (`api.py` module docstring). No new routes or risk/execution surface.

### U5 / U6 / U10 — deferred: UNTOUCHED (confirmed)
- `git diff 69a9251..HEAD --stat` touches no Laya, export/`.akpkg`, registry
  promotion, training-loop, or live/broker files.

## Tests newly reproduced (not inherited)
- `.venv` pytest: `test_ai_wfstress` + `test_ai_history` + `test_ai_api` +
  `test_ai_governance` + `test_ai_orchestrate` — **43 passed**.
- vitest: `regulatory-seed` + `eligibility` + `costs` + research `security` —
  **18 passed, 4 files**.
- `node scripts/lint.mjs` — green.
- NOT RUN (bounded justification): full py/TS suites (no regression signal in
  untouched areas); `verify-research.mjs` (needs built `dist`, environmental);
  anything touching real data, training, backtests, network, or GPUs.

## Outstanding blockers / unverified claims
1. U2 list acquisition (needs NSE-published list + provenance).
2. U3 licensed universe source (never invent mappings).
3. U8 statistical min-windows threshold (unspecified by design).
4. U4 re-baselining as a separately authorized real-market op.
5. License-404 and NSE-unreachability facts inherited, not re-fetched (audit exclusion).

## Confirmations
No training, real-market backtests, broker/live operations, frontend builds,
dataset/processed/runs changes, config changes, branch/commit/push/reset
actions, or U5/U6/U10 modifications occurred during this audit. Only synthetic
fixtures and temp directories were exercised.

## Recommendation
Backend ACCEPTED for the next authorized milestone (frontend-local integration
under U9, or separately-authorized real-data operations for U2/U4-rebaseline).
Do not authorize live trading, broker connection, or model deployment: no
VALIDATED production model exists (U10, correctly deferred).
