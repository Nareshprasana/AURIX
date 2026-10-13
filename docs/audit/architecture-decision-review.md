# Architecture Decision Review — U1–U10

- Commit: `69a9251` (verified HEAD; tree clean at review time).
- Scope: decision analysis ONLY. No code, policy, data, or artifact changed.
- Sources: `docs/audit/master-spec-reconstruction.md` (R/U IDs below),
  `docs/audit/core-backend-audit.md` (108 reqs), `docs/audit/core-backend-gap-plan.md`,
  `docs/architecture.md` v1.0.1, `docs/audit/research-connectors-decision.md`,
  live code/tests/config as cited. Uncertainty is stated, not smoothed over.

---

## U1. Regulatory-intel full worker (cadence, source, scope)

- **Current status:** UNRESOLVED. Architecture defers the full worker to Phase 3+; only schema + fail-closed checks + P1-6 staleness helpers exist.
- **Existing evidence:** `packages/db-bootstrap` eligibility/regulatory_rules DDL; `packages/market-data/src/eligibility.ts` (seed/validate/resolve, stale→UNKNOWN, 5 tests); triple-enforced LEGAL-only boundary (48 tests); no writer/cron anywhere (verified by grep).
- **Options:** (a) NSE announcement scrape on a daily cron; (b) curated seed file refreshed per release; (c) stay schema-only until Phase 3+.
- **Recommendation:** (b) + (c): curated seed file with `as_of` + source URLs, refresh cadence tied to releases, full worker stays Phase 3+. Scraping (a) risks ToS violations and breakage for no approved use case.
- **Trade-offs:** seed data goes stale between releases, but staleness already fails closed to UNKNOWN, so the failure mode is safeia blocking, not bad approvals. Zero new dependencies, zero network code in the safety path.
- **Dependencies:** none (already fail-safe without it).
- **Approval required:** YES — source list and cadence before any writer is built.
- **Acceptance criteria:** seeded rules carry source + `as_of`; stale entries resolve UNKNOWN in a fixture test; boundary suites unchanged.
- **What remains blocked:** nothing for backend acceptance; live-venue expansion later.

## U2. Authoritative NSE holiday calendar list

- **Current status:** UNRESOLVED. Calendar mechanics accept explicit lists (`TradingCalendar.weekdays`, tested with labeled fixtures); no approved list vendored — dates must not be invented.
- **Existing evidence:** 45-gap proof (real NSE holidays surfacing as missing weekdays); costs.test.ts holiday-exclusion test.
- **Options:** (a) vendor NSE-published holiday list with source URL + year version; (b) derive holidays observationally from bhavcopy gaps; (c) leave unlisted (current: holidays treated as sessions).
- **Recommendation:** (a): vendor the NSE-published list per year with provenance; (b) as cross-check only (a gap is evidence of *a* closure, not its reason).
- **Trade-offs:** small annual maintenance; removes false session treatment in backtests. Risk of acting on (c) today: backtests may place fills on holidays — contained by sim-only scope, but wrong.
- **Dependencies:** none.
- **Approval required:** YES — the list itself (source + years).
- **Acceptance criteria:** listed holidays excluded in a fixture test; provenance recorded; no invented dates.
- **What remains blocked:** backtest calendar correctness only; nothing else.

## U3. ISIN-anchored identity + delisted/survivorship source

- **Current status:** UNRESOLVED, not selected. Providers return no ISINs on fetched rows; eod2 ships an `isin_symbol_map` not yet adopted.
- **Existing evidence:** `history.py` provider outputs (symbol-keyed); docs/history-data.md documents the limitation.
- **Options:** (a) adopt eod2 ISIN map as anchor (license check first — no explicit license file found); (b) tej symbol_history parquet (needs pyarrow — new dep); (c) defer.
- **Recommendation:** (a) after license review, else (c). Never invent mappings.
- **Trade-offs:** (a) is lightweight and local-first; (b) adds a heavy dependency for one join.
- **Dependencies:** P1-8 license review (eod2 terms unclear).
- **Approval required:** YES — source selection.
- **Acceptance criteria:** symbol→ISIN resolution test on fixtures; delisted names resolvable or explicitly out-of-scope.
- **What remains blocked:** survivorship-correct backtests; current pipeline unaffected.

## U4. Adjusted-price default policy (raw vs eod2-adjusted)

- **Current status:** UNRESOLVED. CLI default is `--provider tej` (raw bhavcopy); eod2-adjusted path exists and is validated; manifests record the policy honestly either way.
- **Existing evidence:** 50% bonus-divergence cross-check caught live; `adjustment_policy` in every manifest; `adjustSeries` double-apply guard in backtest.
- **Options:** (a) keep raw default; (b) switch default to eod2-adjusted.
- **Recommendation:** (b) for training datasets, (a) retained for audit/raw archives: adjusted closes are the only economically meaningful training input (the RELIANCE bonus proved raw poisons features/labels), while raw must be preserved alongside for provenance. Both already coexist; this only moves the default.
- **Trade-offs:** switching defaults changes every downstream number — requires re-baselining proof metrics (honest recompute, not a code risk). eod2 dividends remain unadjusted (documented residual).
- **Dependencies:** none technically; approval-gated by policy impact.
- **Approval required:** YES — this changes default experimental outcomes.
- **Acceptance criteria:** default-policy test asserting adjusted source; proof metrics recomputed and reported, never overwritten.
- **What remains blocked:** converged-retrain meaningfulness (P1-2 follow-on); nothing structural.

## U5. `.akpkg` encryption and key management

- **Current status:** UNRESOLVED/BLOCKED. Determinism + tamper detection verified; zero crypto code; code comment defers to Phase 11.
- **Existing evidence:** `buildExport`/`verifyExport` + tamper tests; `export.ts:1` deferral note.
- **Options:** (a) password-derived file encryption (PBKDF2 + AES-GCM via Node crypto, no new dep); (b) device key in OS store; (c) stay unencrypted with tamper-evidence only.
- **Recommendation:** decide between (a) and (c) at Phase 11 scope; (b) needs platform-specific work unjustified now. Do NOT invent key handling without a recovery story (lost password = lost archive).
- **Trade-offs:** (a) is implementable in stdlib but adds password UX + recovery risk; (c) keeps current verified guarantees.
- **Dependencies:** Phase 11 scope decision.
- **Approval required:** YES — mechanism + recovery story before any crypto lands.
- **Acceptance criteria:** round-trip test with wrong-password rejection; threat model note.
- **What remains blocked:** nothing for backend acceptance; device transfer works unencrypted.

## U6. Laya role: advisory integration vs removal

- **Current status:** UNRESOLVED. Installed + proven (inference, fine-tune, calibration — prior proof report), unused in any pipeline; no architectural consumer.
- **Existing evidence:** `laya_component.py` (probe/decide/calibration-fit), `laya-train` CLI verified, training proof report numbers.
- **Options:** (a) advisory System-1 role with a defined task + metric + VRAM budget proof beside Ollama; (b) remove from architecture (keep package vendored, unwired).
- **Recommendation:** (b) for now with a re-entry bar: a named decision task, baseline to beat, and measured 4GB-budget coexistence proof. An unused 2.5GB-weight dependency must not ride along by default.
- **Trade-offs:** (b) loses nothing working today; (a) without criteria risks cargo-cult ML.
- **Dependencies:** VRAM measurement + a real decision task.
- **Approval required:** YES — re-entry requires all three bars met.
- **Acceptance criteria:** task definition + metric + budget proof, or removal recorded.
- **What remains blocked:** nothing; numerical + gateway paths are independent.

## U7. Live research connectors

- **Current status:** DECIDED (intake-only cut, `docs/audit/research-connectors-decision.md`). Included here for completeness.
- **Existing evidence:** agents consume caller evidence by design; boundary lint forbids fetcher imports in research.
- **Recommendation:** uphold the cut; revisit only with a sourced, licensed feed + ToS review.
- **Approval required:** YES — any new connector.
- **What remains blocked:** live event-driven research (by design, not by defect).

## U8. Walk-forward/stress threshold values

- **Current status:** PROVISIONAL policy, explicitly marked (`min_oos_edge_vs_baseline: 0.01`, `min_median_sharpe: 0.0` floor, `max_backtest_drawdown_pct: 10.0`). Mechanics implemented + tested; values never spec-claimed.
- **Existing evidence:** gate modes live-tested on synthetic bars; rigged-winner rejection test; policy file comments.
- **Options:** (a) approve floors as-is; (b) tighten (e.g. Sharpe > 0.5, more windows); (c) replace with cost-aware metric gates.
- **Recommendation:** approve (a) as *promotion floors*, not quality claims, with mandatory re-approval once a real VALIDATED candidate exists to calibrate against. Never tune thresholds on the test set.
- **Trade-offs:** loose floors risk weak promotions (contained: PAPER+ stays operator-gated); tight floors risk rejecting everything on noisy Indian EOD data.
- **Dependencies:** U10 (needs a real candidate to calibrate).
- **Approval required:** YES — thresholds are policy, not code.
- **Acceptance criteria:** recorded approval + re-calibration trigger defined.
- **What remains blocked:** VALIDATED status meaningfulness (mechanics work regardless).

## U9. Frontend authorization beyond local token

- **Current status:** DEFERRED to frontend phase by design. Local API (if built in Phase 2 per gap plan) uses bearer-on-loopback.
- **Existing evidence:** api.py design (token ≥16, fail-closed, loopback-only, rate limits) — verify current tree state before relying on it.
- **Options:** (a) keep bearer-on-loopback for a local-only frontend; (b) full session/RBAC model.
- **Recommendation:** (a) unless the frontend leaves the machine — no user accounts exist, so RBAC (b) is machinery without principals.
- **Trade-offs:** (a) is sufficient and auditable for single-user local use.
- **Dependencies:** frontend phase scope (local vs hosted).
- **Approval required:** YES — only if scope exceeds localhost.
- **What remains blocked:** frontend start (needs (a) confirmed, which is a one-line decision).

## U10. No VALIDATED production model

- **Current status:** FACTUAL, not a defect. Proof registry holds one CANDIDATE; trial runs REJECTED honestly; no promotion path was ever bypassed (static + governance tests).
- **Existing evidence:** `docs/training/proof-run/registry.json` (CANDIDATE); `data/runs` trial REJECTED records (untouched); OOS 48.25% vs 50.35% baseline honestly reported.
- **Options:** (a) converged retrain on adjusted data (small, reported separately); (b) leave CANDIDATE-only.
- **Recommendation:** (a) as an explicitly reported operation when authorized — never silent, never overwriting proof history.
- **Trade-offs:** training proves pipeline health, not profitability; a VALIDATED model still needs U8 calibration + live-data soak.
- **Dependencies:** U4 (adjusted default) + U8 (threshold approval).
- **Approval required:** YES — any real-market training run.
- **Acceptance criteria:** manifest + metrics + honest OOS report; registry transition only through gates.
- **What remains blocked:** broker/live phases (correctly).

---

## Groupings

- **Safely approvable together:** U7 (uphold), U6 (defer-with-bar), U9-local (bearer-on-loopback), U2-list + U3-source-pair (same provenance pattern), U5-defer-to-Phase-11.
- **Must come first:** U8 floors before any VALIDATED claim has meaning; U4 before any converged retrain is meaningful.
- **Deferrable without blocking backend acceptance:** U5, U6-re-entry, U2-list (mechanics tested), U9-hosted, U10 (factual state).
- **Blocking frontend readiness:** U9-local confirmation only.
- **Reserved for broker/live phase:** U10-validation, U1-full worker (schema-only suffices), any credential/account work (none exists, none proposed).
- **Recommended sequence:** U8 → U4 → converged retrain (reported op) → U2+U3 sources → U1-seed/U5/U6 per later phases → U9 with frontend.

No decision is marked approved. No code, policy, data, or artifact was modified. Uncertainty above (e.g. exact api.py current state — re-verify before building on it) is stated, not assumed.
