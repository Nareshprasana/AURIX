# Final Decision Sheet — U1–U10 (APPROVED PHASE 4, 2026-10-13)

## Phase-4 approval record (user-authorized; U1–U10 wording below preserved verbatim)

- Authorization baseline: `69a9251`. Final tree/commit recorded in the Phase-4 report.
- APPROVED: U1 (with the three recorded amendments), U2 (source scope; list acquisition BLOCKED — see U2 outcome), U3 (conditional; condition FAILED → deferred), U4, U7 (uphold), U8 (with amendments: floors + recalibration; Sharpe-zero is a sanity check, not profitability evidence), U9 (localhost-only).
- DEFERRED: U5, U6, U10 (all under documented re-entry criteria; real-market retraining NOT authorized).
- NOT authorized: broker connection, live trading, live model deployment, real-market retraining.
- Outcomes: U1 implemented (seed file v1; worker stays Phase 3+) · U2 blocked (NSE publication unreachable, no dates invented) · U3 blocked (no eod2_data license; EOD2 code GPL-3.0 covers code, not NSE-sourced data; no ISIN join, no expansion) · U4 implemented (eod2-adjusted training default; raw retained; re-baselining pending authorized op) · U7 upheld (lint + security tests green) · U8 implemented (floors wired into govern(); malformed/missing gates fail closed; min-windows statistical threshold documented as unspecified blocker) · U9 implemented (malformed interval/timeout → controlled 400s; loopback/rate-limit/audit verified; single-threaded serialization documented as operational, not security).
- Original pre-approval header retained below for provenance (its "AWAITING APPROVAL / nothing approved" statements describe the preparation task, superseded by the record above).

- Baseline: `69a9251` (verified HEAD; tree otherwise clean).
- Scope: read-only preparation. Nothing approved, nothing modified, nothing executed, no commit.
- Sources (IDs/wording retained verbatim): `docs/audit/architecture-decision-review.md`, `architecture-approval-pack.md`, `master-spec-reconstruction.md`, `core-backend-audit.md`, `core-backend-gap-plan.md`, `docs/architecture.md` v1.0.1.
- Convention: **[F]** source-backed fact · **[R]** recommendation (not approval) · **[A]** assumption, flagged.

All ten decisions below are marked **AWAITING USER APPROVAL**. Recommendations are not approvals.

---

## U1. Regulatory-intel full worker (cadence, source, scope) — status: UNRESOLVED
- Source-backed wording: architecture defers the full worker to Phase 3+; only schema + fail-closed checks + staleness helpers exist.
- Evidence [F]: eligibility/regulatory DDL; `eligibility.ts` (seed/validate/resolve, stale→UNKNOWN, 5 tests); triple-enforced LEGAL-only boundary (48 tests); no writer/cron.
- Recommended action: **APPROVE** (curated seed file with `as_of` + source URLs, per-release refresh; full worker stays Phase 3+).
- Proposed decision text: "Approve a curated regulatory seed file (sources + `as_of` recorded, refresh tied to releases). The full regulatory-intel worker remains Phase 3+ scope; no scraping."
- Consequences: staleness keeps failing closed to UNKNOWN (safe blocking, never bad approvals); zero new deps; no network in safety path.
- Dependencies: none. Backend blocker: NO. Frontend blocker: NO. Broker/live phase: live-venue expansion only.
- Acceptance criteria: seeded rules carry source + `as_of`; stale→UNKNOWN fixture test; boundary suites green.

## U2. Authoritative NSE holiday calendar list — status: UNRESOLVED
- Source-backed wording: calendar mechanics accept explicit lists; no approved list vendored — dates must not be invented.
- Evidence [F]: 45 real holidays observed as missing weekdays; `TradingCalendar.weekdays` holiday-exclusion tested with labeled fixtures.
- Recommended action: **APPROVE** (vendor the NSE-published list per year with provenance; bhavcopy-gap derivation as cross-check only).
- Proposed decision text: "Approve adopting the NSE-published holiday list (source URL + year version recorded); gaps usable only as cross-check, since a gap proves a closure but never its reason."
- Consequences: removes false session treatment in backtests; small annual maintenance.
- Dependencies: none. Backend blocker: NO (mechanics verified). Frontend blocker: NO. Broker/live: NO.
- Acceptance criteria: listed holidays excluded in fixture test; provenance recorded; zero invented dates.

## U3. ISIN-anchored identity + delisted/survivorship source — status: UNRESOLVED, not selected
- Source-backed wording: providers return no ISINs on fetched rows; eod2 ships an unused `isin_symbol_map`.
- Evidence [F]: symbol-keyed provider outputs; limitation documented in history-data doc.
- Recommended action: **APPROVE WITH AMENDMENTS** — approve eod2-map adoption *conditional* on license review passing, else defer. Never invent mappings.
- Proposed decision text: "Approve ISIN anchoring via the eod2 map iff its license permits local use; otherwise defer selection. Tej-parquet alternative (pyarrow dep) rejected as disproportionate for one join."
- Consequences: survivorship-correct backtests become possible; license risk contained by the conditional.
- Dependencies: eod2 license review (no explicit license file found). Backend blocker: NO. Frontend blocker: NO. Broker/live: later validation correctness.
- Acceptance criteria: symbol→ISIN fixture test; delisted names resolvable or explicitly out-of-scope.

## U4. Adjusted-price default policy (raw vs eod2-adjusted) — status: UNRESOLVED
- Source-backed wording: CLI default `--provider tej` (raw); eod2-adjusted path exists + validated; manifests record policy honestly; 50% bonus-divergence caught live.
- Evidence [F]: RELIANCE bonus proved raw poisons features/labels; `adjustment_policy` in every manifest; `adjustSeries` double-apply guard.
- Recommended action: **APPROVE** (adjusted default for training datasets; raw retained for audit archives).
- Proposed decision text: "Approve eod2-adjusted as the training-data default; preserve raw archives with provenance; recompute proof metrics honestly without overwriting history. Note residual: eod2 dividends unadjusted."
- Consequences: every downstream number changes (requires re-baselining); training inputs become economically meaningful.
- Dependencies: none technically. Backend blocker: PARTIALLY (retraining meaningless without it). Frontend blocker: NO. Broker/live: NO.
- Acceptance criteria: default-policy test asserting adjusted source; recomputed metrics reported, originals preserved.

## U5. `.akpkg` encryption and key management — status: UNRESOLVED/BLOCKED
- Source-backed wording: determinism + tamper detection verified; zero crypto; deferred to Phase 11.
- Evidence [F]: `buildExport`/`verifyExport` + tamper tests; deferral comment in code.
- Recommended action: **DEFER** (decide password-derived vs unencrypted at Phase 11 scope; OS-store key rejected now).
- Proposed decision text: "Defer encryption to Phase 11; require mechanism + recovery story before any crypto lands. Lost password = lost archive is unacceptable without a designed recovery."
- Consequences: device transfer continues unencrypted with tamper-evidence (verified, sufficient today).
- Dependencies: Phase 11 scope. Backend blocker: NO. Frontend blocker: NO. Broker/live: NO.
- Acceptance criteria (later): round-trip + wrong-password rejection test; threat-model note.

## U6. Laya role: advisory integration vs removal — status: UNRESOLVED
- Source-backed wording: installed + proven (inference/fine-tune/calibration), unused in any pipeline; no architectural consumer.
- Recommended action: **DEFER with explicit re-entry condition** (named task + baseline + 4GB coexistence proof).
- Proposed decision text: "Defer Laya integration; keep package vendored but unwired. Re-entry requires all three bars met."
- Consequences: nothing working is lost; avoids cargo-cult ML and an idle 2.5GB dependency riding by default.
- Dependencies: VRAM measurement + real task. Backend blocker: NO. Frontend blocker: NO. Broker/live: NO.
- Acceptance criteria: task + metric + budget proof, or removal recorded.

## U7. Live research connectors — status: DECIDED (intake-only cut)
- Source-backed wording: agents consume caller evidence by design; lint forbids fetcher imports.
- Recommended action: **APPROVE** (uphold the cut; revisit only with sourced, licensed feed + ToS review).
- Proposed decision text: "Uphold intake-only research scope; any future connector needs source, license, and ToS review."
- Consequences: live event-driven research stays out by design, not by defect.
- Dependencies: none. Backend blocker: NO. Frontend blocker: NO. Broker/live: NO.
- Acceptance criteria: already met (decision record exists).

## U8. Walk-forward/stress threshold values — status: PROVISIONAL (`min_oos_edge_vs_baseline: 0.01`, `min_median_sharpe: 0.0` floor, `max_backtest_drawdown_pct: 10.0`)
- Source-backed wording: mechanics implemented + tested; values never spec-claimed.
- Evidence [F]: gate modes live on synthetic bars; rigged-winner rejection test; policy comments mark floors provisional.
- Recommended action: **APPROVE WITH AMENDMENTS** — approve as promotion floors (not quality claims) with mandatory re-calibration once a real VALIDATED candidate exists; never tune on the test set.
- Proposed decision text: "Approve the three floors as promotion gates with a recorded re-calibration trigger on first VALIDATED candidate."
- Consequences: gates mean something before any VALIDATED claim; loose floors contained (PAPER+ stays operator-gated); tight floors risk rejecting everything on noisy EOD data.
- On the Sharpe-zero question [A→clarified]: a 0.0 floor is a *non-negativity sanity check on median out-of-window risk-adjusted return*, not evidence of profitability. Its role: reject regime-fragile or consistently-losing strategies, nothing more. Limitations: median over ≤4 windows has wide error bars (sample requirement: minimum windows configured, currently 4); Sharpe on few trades is unstable; recalibration trigger above handles drift. If this rationale is insufficient, mark NEEDS CLARIFICATION rather than approving.
- Dependencies: U10 (real candidate to calibrate). Backend blocker: YES (VALIDATED meaningfulness). Frontend blocker: NO. Broker/live: YES (gates live promotion).
- Acceptance criteria: recorded approval + re-calibration trigger.

## U9. Frontend authorization beyond local token — status: DEFERRED to frontend phase
- Source-backed wording: bearer-on-loopback design; no user accounts exist.
- Evidence [F]: full-file API read this review cycle (5 routes, uniform auth, fail-closed token, loopback-only bind, 60/min, 64KiB cap, redacted audit, generic errors).
- Recommended action: **APPROVE** (bearer-on-loopback for local-only frontend; sessions/RBAC only if scope leaves the machine).
- Proposed decision text: "Confirm local-only frontend scope with bearer-on-loopback auth; revisit only if scope exceeds localhost."
- Consequences: sufficient, auditable single-user security; no machinery without principals.
- Dependencies: frontend scope. Backend blocker: NO. Frontend blocker: YES (one-line confirmation). Broker/live: NO.
- Acceptance criteria: scope confirmation recorded.

## U10. No VALIDATED production model — status: FACTUAL, not a defect
- Source-backed wording: one CANDIDATE in proof registry; trial runs honestly REJECTED (48.25% vs 50.35%); no bypass ever.
- Recommended action: **DEFER** (authorize retraining only as a separately reported operation — see chain below).
- Proposed decision text: none today; a future retrain authorization must carry scope, budget, and acceptance criteria.
- Dependencies: U4 + U8. Backend blocker: NO (pipeline health proven). Frontend blocker: NO. Broker/live: YES (correctly).
- Acceptance criteria (for the future op): manifest + metrics + honest OOS; gate-only promotion.

---

## Group evaluation (verified against the pack — all retained)

- **Batch-approvable:** U7, U6-defer, U9-local, U2+U3 (with U3's license conditional), U5-defer. Evidence supports each; all reversible.
- **U8/U4/U10 chain:** verified as stated. U8 (approve floors) → U4 (adjusted default + re-baselining) → U10 (authorized retrain as reported op). Each link's change/verify/preserve/risk is detailed in the U-entries above.
- **Master Spec:** recommend **approve with amendments** — (1) R11 thresholds provisional pending U8; (2) connector scope = decided cut per U7; (3) Laya = deferred per U6. Do not treat as authoritative until amended; full approval waits for U8 + one observed VALIDATED-or-honest-REJECTED cycle under approved floors. No conflicts found between reconstruction, architecture, and code beyond the listed provisionals.
- **API/frontend boundary:** core acceptance = current uniform-auth design (verified); integration readiness = U9-local + `interval`/`timeout` TypeError hardening (minor fix, queued for implementation phase); production hardening (TLS-terminating reverse proxy, concurrent-load proof) = broker/live phase, not frontend; socket-concurrency marked unverified with a minimal two-client test specified.

## Decision matrix

| ID | Decision | Recommendation | Dependency | Backend blocker? | Frontend blocker? | Awaiting approval? |
|---|---|---|---|---|---|---|
| U1 | Regulatory worker | APPROVE (seed file; worker stays Phase 3+) | none | NO | NO | YES |
| U2 | Holiday list | APPROVE (vendor NSE list) | none | NO | NO | YES |
| U3 | ISIN source | APPROVE WITH AMENDMENTS (conditional on license) | license review | NO | NO | YES |
| U4 | Adjusted default | APPROVE (re-baseline honestly) | none | PARTIAL | NO | YES |
| U5 | akpkg encryption | DEFER to Phase 11 | Phase 11 scope | NO | NO | YES (deferral) |
| U6 | Laya role | DEFER with re-entry bar | task+metric+budget | NO | NO | YES (deferral) |
| U7 | Connectors cut | APPROVE (uphold) | none | NO | NO | YES |
| U8 | WF/stress floors | APPROVE WITH AMENDMENTS (floors + recalibration) | U10 to calibrate | YES | NO | YES |
| U9 | Frontend auth | APPROVE (local-only) | frontend scope | NO | YES | YES |
| U10 | Retrain op | DEFER (separate authorization) | U4+U8 | NO | NO | YES |

## Proposed approval sequence

1. Batch: U7, U6, U9-local, U5-defer (no dependencies, fully reversible).
2. U2 + U1-seed + U3-conditional (same provenance pattern; U3 resolves after its license check).
3. U8 floors + recalibration trigger (unlocks gate meaningfulness).
4. U4 adjusted default + honest re-baselining (unlocks meaningful retraining).
5. U10 retrain as a separately scoped, reported operation (unlocks broker-phase readiness).

**Prohibited until separately authorized:** real-market training/retraining, live backtests, LLM probes, broker credentials/accounts, live-trading enablement, promotion bypasses, proof-history rewrites, invented dates/mappings/thresholds. No decision approved in this task.
