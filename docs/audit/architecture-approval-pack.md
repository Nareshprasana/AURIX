# Architecture Approval Pack — U1–U10

- Baseline: `69a9251` (verified HEAD before and after; tree otherwise clean).
- Scope: decision preparation ONLY. No code, policy, data, or artifact changed; nothing executed; no commit.
- Sources: `docs/audit/architecture-decision-review.md` (IDs/wording retained verbatim below), `master-spec-reconstruction.md`, `core-backend-audit.md` (108 reqs), `core-backend-gap-plan.md`, `docs/architecture.md` v1.0.1, `services-python/aurix_ai/api.py` + `tests/test_ai_api.py` (read-only re-verification this task).
- Legend: **[F]** source-backed fact · **[R]** recommendation · **[A]** assumption (flagged as such).

## Executive recommendation

Approve as a batch: U2-list, U3-source-pair, U6-defer-with-bar, U7-uphold, U9-local — all low-risk, fully reversible, unblocking backend acceptance and frontend start. Approve U8 floors as *promotion floors with mandatory re-calibration trigger* (not quality claims). Defer U5, U6-re-entry, U9-hosted, and the full U1 worker to their stated phases. Treat U4 (adjusted default) as the single highest-leverage approval: it unblocks meaningful retraining. Treat U10 as a factual state requiring a separately authorized operation, not a decision to "approve" today.

## U1–U10 decision matrix

### U1. Regulatory-intel full worker (cadence, source, scope) — status: UNRESOLVED
- Existing evidence [F]: schema + fail-closed checks + staleness helpers exist; triple-enforced LEGAL-only boundary (48 tests); no writer/cron anywhere.
- Recommended choice [R]: curated seed file (`as_of` + source URLs, per-release refresh); full worker stays Phase 3+.
- Reason: fail-closed UNKNOWN already makes staleness safe; scraping risks ToS violations with no approved use case.
- Alternatives/trade-offs: NSE scrape (breakage + ToS risk) vs schema-only freeze (current safe state, kept as fallback).
- Dependencies: none. Blocks backend acceptance: NO. Blocks frontend: NO. Broker/live phase: only live-venue expansion.
- Acceptance criteria: seeded rules carry source + `as_of`; stale→UNKNOWN fixture test; boundary suites green.
- Approval required: source list + cadence before any writer is built.

### U2. Authoritative NSE holiday calendar list — status: UNRESOLVED
- Existing evidence [F]: `TradingCalendar.weekdays` accepts explicit lists (tested); 45 real holidays observed as missing weekdays; no approved list vendored.
- Recommended choice [R]: vendor the NSE-published list per year with provenance; bhavcopy-gap derivation as cross-check only.
- Reason: mechanics tested; a gap proves *a* closure, never its reason — only the publisher's list is authoritative.
- Alternatives/trade-offs: leave unlisted (backtests may fill on holidays — wrong but sim-contained); small annual maintenance cost for (R).
- Dependencies: none. Blocks backend acceptance: NO (mechanics verified). Blocks frontend: NO. Broker/live: NO.
- Acceptance criteria: listed holidays excluded in fixture test; provenance recorded; zero invented dates.
- Approval required: the list itself (source + years).

### U3. ISIN-anchored identity + delisted/survivorship source — status: UNRESOLVED, not selected
- Existing evidence [F]: fetched rows carry no ISINs; eod2 ships an unused `isin_symbol_map`; limitation documented.
- Recommended choice [R]: adopt the eod2 map as anchor AFTER license review, else defer. Never invent mappings.
- Reason: lightweight, local-first; tej-parquet alternative needs pyarrow (new heavy dep) for one join.
- Alternatives/trade-offs: as above; deferral keeps survivorship-blind backtests (documented, sim-contained).
- Dependencies: eod2 license review (no explicit license file found) [A: review outcome unknown].
- Approval required: YES — source selection.
- Acceptance criteria: symbol→ISIN fixture test; delisted names resolvable or explicitly out-of-scope.
- Blocks backend acceptance: NO. Blocks frontend: NO. Broker/live: survivorship-correct validation later.

### U4. Adjusted-price default policy (raw vs eod2-adjusted) — status: UNRESOLVED
- Existing evidence [F]: CLI default `--provider tej` (raw); eod2-adjusted path exists + validated; manifests record policy honestly; 50% bonus-divergence caught live.
- Recommended choice [R]: adjusted default for training datasets; raw retained for audit archives.
- Reason: raw closes provably poison features/labels (RELIANCE bonus); both representations already coexist, so only the default moves.
- Alternatives/trade-offs: keep raw (continued poisoned training inputs) vs switch (every downstream number changes → honest re-baselining required). Residual: eod2 dividends unadjusted.
- Dependencies: none technically. Blocks backend acceptance: PARTIALLY (retraining meaningless without it). Blocks frontend: NO. Broker/live: NO.
- Acceptance criteria: default-policy test asserting adjusted source; proof metrics recomputed and reported, never overwritten.
- Approval required: YES — changes default experimental outcomes.

### U5. `.akpkg` encryption and key management — status: UNRESOLVED/BLOCKED
- Existing evidence [F]: determinism + tamper detection verified; zero crypto code; Phase-11 deferral comment.
- Recommended choice [R]: decide password-derived (stdlib PBKDF2+AES-GCM) vs unencrypted-at-Phase-11; OS-store key rejected as unjustified platform work.
- Reason: no recovery story exists; lost password = lost archive. Do not invent key handling.
- Alternatives/trade-offs: as above; staying unencrypted keeps verified guarantees.
- Dependencies: Phase 11 scope. Blocks backend acceptance: NO. Blocks frontend: NO. Broker/live: NO.
- Acceptance criteria: round-trip + wrong-password rejection test; threat-model note.
- Approval required: YES — mechanism + recovery story.

### U6. Laya role: advisory integration vs removal — status: UNRESOLVED
- Existing evidence [F]: installed + proven (inference/fine-tune/calibration per prior proof report); zero pipeline consumers.
- Recommended choice [R]: defer with re-entry bar (named task + baseline + 4GB coexistence proof); keep package vendored, unwired.
- Reason: an unused 2.5GB-weight dependency must not ride along by default; integration without criteria is cargo-cult ML.
- Alternatives/trade-offs: removal recorded vs advisory role — nothing working is lost either way today.
- Dependencies: VRAM measurement + real task. Blocks backend acceptance: NO. Blocks frontend: NO. Broker/live: NO.
- Acceptance criteria: task + metric + budget proof, or removal recorded.
- Approval required: YES — re-entry only when all three bars met.

### U7. Live research connectors — status: DECIDED (intake-only cut)
- Existing evidence [F]: agents consume caller evidence by design; lint forbids fetcher imports in research; decision record exists.
- Recommended choice [R]: uphold; revisit only with sourced, licensed feed + ToS review.
- Dependencies: none. Blocks backend acceptance: NO. Blocks frontend: NO. Broker/live: NO.
- Acceptance criteria: already met (record exists). Approval required: YES — any new connector.

### U8. Walk-forward/stress threshold values — status: PROVISIONAL (`min_oos_edge_vs_baseline: 0.01`, `min_median_sharpe: 0.0` floor, `max_backtest_drawdown_pct: 10.0`)
- Existing evidence [F]: mechanics implemented + tested (gate modes live on synthetic bars; rigged-winner rejection test); values never spec-claimed.
- Recommended choice [R]: approve as promotion floors with mandatory re-calibration once a real VALIDATED candidate exists; never tune on the test set.
- Reason: gates must mean something before any VALIDATED claim; loose floors are contained (PAPER+ stays operator-gated).
- Alternatives/trade-offs: tighten now (risks rejecting everything on noisy EOD data) vs cost-aware redesign (larger work, same calibration problem).
- Dependencies: U10 (needs a real candidate to calibrate). Blocks backend acceptance: YES (VALIDATED meaningfulness). Blocks frontend: NO. Broker/live: YES (gates live promotion).
- Acceptance criteria: recorded approval + re-calibration trigger.
- Approval required: YES — thresholds are policy, not code.

### U9. Frontend authorization beyond local token — status: DEFERRED to frontend phase
- Existing evidence [F]: re-verified this task — `api.py` implements bearer-on-loopback only (details below); no user accounts exist anywhere.
- Recommended choice [R]: bearer-on-loopback for a local-only frontend; full sessions/RBAC only if scope leaves the machine.
- Reason: RBAC without principals is machinery without users.
- Dependencies: frontend scope (local vs hosted). Blocks backend acceptance: NO. Blocks frontend: YES (one-line confirmation). Broker/live: NO.
- Acceptance criteria: confirm local-only scope.
- Approval required: YES — only if scope exceeds localhost.

### U10. No VALIDATED production model — status: FACTUAL, not a defect
- Existing evidence [F]: proof registry holds one CANDIDATE; trial runs honestly REJECTED (OOS 48.25% vs 50.35%); no bypass ever (static + governance tests).
- Recommended choice [R]: converged retrain on adjusted data as an explicitly reported operation when authorized — never silent, never overwriting history.
- Dependencies: U4 (meaningful inputs) + U8 (meaningful gates). Blocks backend acceptance: NO (pipeline health is proven; model quality is separate). Blocks frontend: NO. Broker/live: YES (correctly).
- Acceptance criteria: manifest + metrics + honest OOS report; registry transition only through gates.
- Approval required: YES — any real-market training run.

## Verified dependency chain (U4 → U8 → U10)

- **U8 first:** floors must be approved before any VALIDATED claim means anything. Change after approval: `govern()` promotes only above approved floors. Verify: rigged-winner test with approved values. Preserve: policy file version + test logs. Risk of skipping: meaningless VALIDATED status.
- **U4 second:** adjusted default makes training inputs economically meaningful. Change: CLI default + proof-metric recompute. Verify: default-policy test + manifest `adjustment_policy`. Preserve: raw archives + original proof numbers. Risk of skipping: retraining on poisoned inputs (proven 50% artifact).
- **U10 last:** authorized retrain is a future operation with scope (dataset version, epochs, budget, seed) + acceptance (manifest, metrics, honest OOS, gate-only promotion). Risk of skipping process: silent/unverifiable training. **Not started in this task.**

## Grouping by milestone

- **Group A (backend acceptance):** U8 (gates must mean something). U1/U2/U3/U5/U6/U9/U10 do not block it — stated explicitly per item above.
- **Group B (frontend):** U9-local confirmation only.
- **Group C (safe to defer):** U1-full worker, U2-list (mechanics tested), U3 (pipeline unaffected), U5, U6-re-entry, U9-hosted.
- **Group D (broker/live):** U10-validation, U1-venue expansion, U3-survivorship validation, any credential/account work (none exists).

## Master Spec recommendation

**Approve the reconstruction with amendments, do not treat it as authoritative yet.** Supported: R1–R10, R12–R15 (architecture + phase evidence). Ambiguous: R11 thresholds (= U8), R6-encryption (= U5), R7-connector scope (= U7, decided). Safety/governance-affecting: R11, R5 (AUTONOMOUS_LIVE stays disabled — no conflict found between reconstruction, architecture, and code). Amendments required: (1) mark R11 thresholds provisional pending U8; (2) mark research-connector scope as decided-cut per U7; (3) record Laya as deferred per U6. Defer full approval pending: U8 decision + one observed VALIDATED-or-honest-REJECTED cycle under approved floors.

## API-security findings (full-file read, no execution)

- Routes/methods: `GET /health`, `GET /v1/training/state`, `GET /v1/training/events?last=N`, `POST /v1/training/start`, `POST /v1/training/stop`. No others.
- Authorization: identical on all routes — `_guard()` order is rate-limit → body-size → Bearer check; every route including `/health` requires a valid token. No per-route roles (none needed: single operator).
- Token: ctor arg or `AURIX_API_TOKEN`; missing/short (<16) refuses startup (fail-closed); `hmac.compare_digest`; stored in server memory only; audit pops token/authorization fields (verified by test asserting absence).
- Bind: constructor rejects non-loopback hosts. Rate: 60/min/IP token bucket. Size: 64 KiB cap (413). Audit: per-request JSONL (route/client/status/note). Errors: generic bodies; 500 path hides exception text.
- Gaps affecting frontend: (1) single-threaded `HTTPServer` serializes concurrent requests — fine for local single-user, must be stated, not fixed with new infra; (2) `interval`/`timeout` body params raise uncaught `TypeError` on wrong types (→ dropped connection, not JSON error) — minor robustness fix for implementation phase; (3) rate-limit-before-auth lets unauthenticated clients burn bucket — negligible on loopback, noted.
- Unverified without execution: socket-level concurrency behavior, restart persistence of the audit log under crash. Smallest safe later test: two parallel localhost clients asserting serialized-but-correct responses (no new harness needed).

## Implementation order after approval

1. U8 (record floors) → 2. U4 (switch default + recompute baselines) → 3. U2+U3 sources (same provenance pattern) → 4. U1-seed content → 5. U9-local confirmation alongside frontend start → 6. U5/U6 per later phases → 7. Authorized retrain as reported op.
- Approvable together: U7-uphold, U6-defer, U9-local, U2+U3, U5-defer.
- Needs clarification: none blocking — U3 license sub-question resolves inside its own approval (adopt iff license permits, else defer).

## Prohibited until separately authorized

Real-market training/retraining, backtests on live data, LLM probes, broker credentials/accounts, live trading enablement, promotion bypasses, AlmaLinux-scale infra, rewriting proof history, inventing dates/mappings/thresholds.

No decisions approved. No application code or data modified.
