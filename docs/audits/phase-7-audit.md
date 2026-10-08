# AURIX Phase 7 Audit Report — Portfolio Construction, Capital Allocation & Risk Integration

**Scope:** Phase 7 implementation against the Phase 7 brief (§§1–53), Master Spec
portfolio/risk requirements, architecture v1.0.1 + `config/portfolio-policy.v1.yaml`,
`tasks/phase-7-plan.md` (§1–§7). Phases 1–6 + cumulative regression required.
**Baseline:** P1 `b593a49`+`5746c9b`, P2 `7a62677`+`503cd85`, P3 `caf2386`+`d199bc7`,
P4 `5e19636`+`b6469a8`, P5 `7666708`+`f3308b2`, cumulative `d09a48f`,
P6 `0811fb4`+`8719f62` (all PASS).
**Method:** code re-read + repo-wide searches + full test execution. Test-green treated as
necessary but not sufficient; each §46 area re-proven against the implementation.

## 1. Audit areas (§46) — verdicts

| Area | Verdict + evidence |
|---|---|
| Portfolio domain model | PASS — Portfolio/Position/Candidate/Capital/RiskDecision/Rebalance/Snapshot/Decision contracts persisted with provenance; versioned decisions reproducible from stored inputs |
| Capital model | PASS — reserved-aware (reserved never deployable), margin-locked availability, empty-account and zero-capital rejection tested |
| Allocation | PASS — six deterministic methods, bounded outputs, explanations; empty set → empty weights (NO_TRADE input); determinism asserted by re-execution |
| Position sizing | PASS — five methods with explicit inputs/bounds/explanations; unknown-vol/ADV fail to zero, never to a guess; final = min(methods, risk cap) |
| Concentration | PASS — top-N + HHI exact; sector buckets via knowledge ids with unknown-bucket isolation (never zeroed) |
| Correlation | PASS — matrix view with cluster listing + unknown-pair inventory; connected-component gate scales correlated sets pro-rata (tested 4×2%→1.5%) |
| Sector exposure | PASS — resolves through knowledge sector ids; missing classification REJECTs (never silent zero); unknown-bucket cap enforced |
| Liquidity | PASS — ADV/spread/volume gates; UNKNOWN blocks entries; exits capped-not-blocked; wide spreads rejected |
| Leverage/margin | PASS — caps enforced pre-trade; current-book leverage derived from positions; margin assumed 0 recorded as assumption (no broker data in Phase 7) |
| Drawdown | PASS — band machine NORMAL/CAUTION/RESTRICTED/HALTED at 4/6/8% + daily-loss halt; HALTED vetoes everything (tested) |
| Daily loss | PASS — breach halts new risk independently of drawdown (tested both) |
| Abnormal market | PASS — 50% haircut on position/sector caps (tested 2%→1%); no LLM override path exists |
| Risk veto | PASS — REJECT/UNKNOWN candidates never approved; portfolio-level REJECT/UNKNOWN vetoes individually-ALLOW candidates (tested both layers) |
| Rebalance | PASS — seven intents with exact semantics (NO_CHANGE≠HOLD fixed during audit); turnover budget largest-first with deferral reasons; BLOCKED for rejected with zeroed deltas |
| Strategy attribution | PASS — position→strategy→signal versions on every target; evidence refs + version map on decisions |
| Risk attribution | PASS — rule-level decisions per candidate (observed/limit/utilization/explanation/trace); cluster/sector/gross attribution recorded |
| Memory | PASS — allocation/reject/violation/drawdown/structure records via strategy memories; identical reruns reuse (no duplicate state, kv unchanged) |
| Knowledge | PASS — decisions + memories committed as OBSERVATION with provenance; never FACT; idempotent persist |
| Events | PASS — entity-scoped invalidation (affected dropped, others kept); reuses Phase 5 machinery, no duplicate engine |
| Data quality | PASS — critical-input failures force UNKNOWN (price/adv/spread/sector/vol each tested); MISSING treated as failure; zero never substituted |
| Reproducibility | PASS — deterministic decision ids; rerun yields identical decision objects and zero new knowledge writes |
| Idempotency | PASS — decision/knowledge/memory writes all guarded by existence checks (tested) |
| Resource usage | PASS — pure functions, bounded fixtures, no parallelism/cloud/paid deps; full suite ~15s |
| LLM boundary | PASS — no gateway/model imports in portfolio code (lint + scans); allocation/risk contain zero LLM inputs by construction |
| Broker boundary | PASS — no broker/execution imports; intents are non-broker vocabulary; proof script scans + asserts |
| Execution boundary | PASS — same as broker: no path, no shared types, no reference |
| Security | PASS — secret scan on registration; redaction via existing layers; prompt-injection cannot reach limits/weights/mode (no LLM in path — nothing to inject into) |
| Test integrity | PASS — 387 tests, zero skips, hand-computed expectations, trap tests; zero prior files modified |

## 2. Required findings sweep (F-P7-1…15)

F-P7-1 allocation bypass: PASS — risk caps bind after allocation; sized = min(methods, risk); portfolio-gate veto tested. F-P7-2 rebalance bypass: PASS — rejected instruments forced BLOCKED with zeroed deltas post-budget. F-P7-3 LLM weights: PASS — no LLM weight input exists in any signature (verified). F-P7-4 UNKNOWN→safe: PASS — UNKNOWN verdicts block (tested per-key + service-level). F-P7-5 correlation math: PASS (component scaling tested). F-P7-6 sector taxonomy: PASS — single knowledge-id taxonomy, unknown bucketed. F-P7-7 liquidity leakage: PASS — market snapshot is the fresh authority (service refreshes candidate liquidity; stale signal-time values kept only for audit). F-P7-8 drawdown/daily math: PASS (band + halt tests). F-P7-9 sizing over limits: PASS — finalizeSize takes minimum with risk cap. F-P7-10 state duplication: PASS — idempotent persist tested. F-P7-11 broker leakage: PASS (proofs 1–2). F-P7-12 attribution: PASS (position→evidence chain test). F-P7-13 churn: PASS — turnover budget with deferral + reasons. F-P7-14 determinism: PASS (rerun identity). F-P7-15 quality bypass: PASS (gate tests + service UNKNOWN test).

## 3. Findings fixed during implementation (before this report)

- **F-P7-A (MEDIUM, FIXED):** market snapshot was not authoritative — candidate-level
  liquidity bypassed the risk UNKNOWN gate (deleted market ADV still passed via stale
  signal-time values), and `daily_pnl_override` never reached the risk engine (daily-halt
  silently dead). Fixed: service refreshes candidate liquidity from market + feeds daily
  loss into risk; both paths now tested (UNKNOWN block, daily halt).
- **F-P7-B (MEDIUM, FIXED):** portfolio-level REJECT (e.g. drawdown HALT) did not veto
  individually-ALLOW candidates — `approved` filled and outcome read TRADE. Fixed:
  portfolio-gate block with per-instrument reasons; HALTED test now yields RISK_BLOCKED
  with zero targets.
- **F-P7-C (LOW, FIXED):** rebalance conflated HOLD (held, no change) with NO_CHANGE
  (not held, no change). Fixed: delta===0 splits on current holdings; test pins both.
- **F-P7-D (LOW, FIXED):** current-book top-5/leverage were hardcoded (0/1.0) instead of
  derived. Fixed: derived from actual positions via existing helpers; margin-0 recorded
  as explicit assumption.
- **Process notes:** ~10 typecheck iterations from cross-package contract growth (all
  resolved, never weakened); one self-inflicted double-wrap bug in service wiring caught
  by tests; one stray no-op shell probe; no effect.

## 4. Severity classification

No CRITICAL or HIGH findings. MEDIUM: F-P7-A, F-P7-B (fixed + tested). LOW: F-P7-C,
F-P7-D (fixed). INFORMATIONAL (non-blocking):
- O1: fixed-fraction sizing hardcodes its demo percentage in the service call (2%);
  policy file carries the authoritative value — wire-through is Phase 8 work.
- O2: cost model in rebalance estimates is a static default, not per-strategy; estimates
  labeled as such on every line.
- O3: factor exposures (beta/size/value/momentum) not computed — no factor data exists
  in Phase 7; approximation explicitly not fabricated.
- O4: correlation matrix is an input, not estimated in-engine (estimation is research
  work for later phases); UNKNOWN pairs handled conservatively.
- O5: `APPROVED`/`PAPER_ELIGIBLE` lifecycle states exist on strategies but Phase 7
  performs no promotion; no activation path exists.
- O6: drawdown/daily inputs to risk are caller-supplied (service passes overrides);
  live-computed equity curves arrive with portfolio state in later phases.

## 5. Regression + verification (executed)

- `pnpm test`: **67 files, 387 tests, all pass** (341 prior intact — zero prior test
  files modified or deleted; scope is portfolio/service + wiring only).
- `pnpm typecheck`: clean. `pnpm lint`: clean (new portfolio boundary rules executing).
- `pytest`: **17 passed** (15 prior + 2 parity).
- `pnpm build` clean; all eight verify scripts ok, including new `verify-portfolio`
  (§42 loop + §43 six impossibility proofs + §44 rerun identity: 17/17 checks).
- Searches: portfolio trees contain no broker/execution/risk-live/gateway/training/
  eval/exec/shell references; Python portfolio module has no writers/secrets.

## 6. Final verdict

**PASS** — Phase 7 delivers risk-controlled hypothetical portfolio decisions with the
required separation (strategy ≠ allocation ≠ risk), veto-authoritative deterministic
risk on Phase 1 limits, fail-safe UNKNOWN handling, and absolute broker/live
isolation. All findings fixed and verified.
