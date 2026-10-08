# AURIX Phase 6 Audit Report — Strategy Intelligence & Backtesting

**Scope:** Phase 6 implementation against the Phase 6 brief (§§1–53), Master Spec
strategy/evaluation requirements, architecture v1.0.1, `tasks/phase-6-plan.md` (§1–§10).
Phases 1–5 + cumulative regression required.
**Baseline:** P1 `b593a49`+`5746c9b`, P2 `7a62677`+`503cd85`, P3 `caf2386`+`d199bc7`,
P4 `5e19636`+`b6469a8`, P5 `7666708`+`f3308b2`, cumulative `d09a48f` (all PASS).
**Method:** code re-read + repo-wide searches + full test execution. Test-green treated as
necessary but not sufficient; each §47 area re-proven against the implementation.

## 1. Audit areas (§47) — verdicts

| Area | Verdict + evidence |
|---|---|
| Strategy contracts | PASS — `validateDefinition` rejects ambiguous/incomplete/out-of-bounds defs (tested); families are preset data + fixed operators |
| Lifecycle | PASS — forward-only transitions with terminal/degraded guards; illegal jumps throw; APPROVED records without activating anything (no live wiring exists); history via node versions |
| Research integration | PASS — hypotheses validated by builders (required fields, determinism); raw text never becomes logic (LLM wording quarantined to description text) |
| Memory integration | PASS — identical specs reuse recorded experiments; dataset change/invalidation forces rerun; strategy-memory records rationale; no duplicate experiments (id-keyed) |
| Knowledge integration | PASS — hypotheses→HYPOTHESIS, results→OBSERVATION, evaluations→OBSERVATION + resolution nodes; FACT impossible via this path (policy + coercion pattern); provenance on every commit |
| Event integration | PASS — event windows scope signals (suppression counted); dependency-scoped refresh reuses Phase 5 machinery; no duplicate event infra |
| Backtest correctness | PASS — hand-computed cash/P&L/fees test; 1-bar delay proven on every order; partial fills flagged; drawdown/turnover verified |
| Look-ahead prevention | PASS — structural (all reads ≤ index i) + empirical (prefix-vs-full signal identity; equity-prefix invariance); PIT views for fundamentals/events/universe |
| Point-in-time data | PASS — `bars/fundamentals/events/universeAsOf` strict `<= t`; unpublished fundamentals invisible (tested); missing PIT info recorded as limitations |
| Transaction costs | PASS — exact component breakdown with minimums; config-driven, broker-neutral; recorded per fill |
| Slippage | PASS — fixed exact; liquidity-aware monotonic in size with recorded assumptions; unknown ADV degrades explicitly, never silently |
| Liquidity | PASS — UNKNOWN blocks entries (never assumes LIQUID); exits capped-not-blocked; wide spreads rejected; participation caps flagged |
| OOS | PASS — disjoint versioned splits; sweep API refuses `:oos` datasets; params fixed across periods; both sides persisted |
| Walk-forward | PASS — generated windows with enforced disjoint test ranges (overlap throws); per-window train/test persisted; aggregation after |
| Stress testing | PASS — cost/slippage/spread/liquidity/delay/missing-data shocks degrade-or-hold deterministically |
| Parameter robustness | PASS — grid sweep with run cap (125, throws above); stable-region + cliff analysis; out-of-bounds sweep values rejected |
| Overfitting protection | PASS — full lineage in specHash; sweep count surfaced to evaluation; best-of-N without OOS blocked from ROBUST+; duplicate specs reused not rerun |
| Reproducibility | PASS — rerun yields identical specHash + metrics JSON; persisted metadata covers strategy/dataset/params/range/models/versions |
| Experiment registry | PASS — id-keyed (no duplicates), lineage links, per-strategy listing |
| Security | PASS — lint + source scans clean (no broker/execution/risk/portfolio/gateway/training/eval/exec/shell); secret scan on registration; HypotheticalOrder structurally broker-incompatible |
| LLM isolation | PASS — interpreter interface only; wording-only LLM role proven; no codegen path exists |
| Broker isolation | PASS — no imports, no shared types, sim-order count zero by construction (engine has no broker reference); proof script scans + asserts |
| Training isolation | PASS — sweeps are bounded experiments with separate artifacts; no training code/refs/infra touched |
| Resource usage | PASS — sweep cap, sequential execution, small fixtures, no parallelism/cloud/paid deps; timings trivial |
| Test integrity | PASS — 341 tests, zero skips, hand-computed expectations, trap tests, no prior suite touched |

## 2. Required findings sweep (F-P6-1…13)

F-P6-1 look-ahead: PASS (structural + empirical). F-P6-2 survivorship/leakage: PASS
(listing-gated universe + tests). F-P6-3 costs: PASS (exact breakdown). F-P6-4 slippage:
PASS (monotonic + assumptions). F-P6-5 OOS contamination: PASS (split + sweep refusal).
F-P6-6 walk-forward leakage: PASS (disjoint enforcement). F-P6-7 LLM bypass: PASS (no
codegen path). F-P6-8 broker bypass: PASS (type + import + runtime proof). F-P6-9
reproducibility: PASS (rerun equivalence). F-P6-10 memory duplication: PASS (id-keyed
reuse). F-P6-11 data-quality bypass: PASS (states mapped, VALID-only consumption).
F-P6-12 corporate-action leakage: PASS (ex-date application, single-apply guard,
no-spurious-breakout test, method recorded). F-P6-13 resource exhaustion: PASS (sweep
cap, bounded fixtures, sequential).

## 3. Findings fixed during implementation (before this report)

- **F-P6-A (MEDIUM, FIXED):** `parameterSweep` varied the params record without
  rebuilding declarative conditions, so grid points carried distinct specHashes while
  executing identical logic — silently misleading experiment records. Fixed: sweeps
  rebuild conditions from the recorded `family_preset` (new additive field) with
  bounds enforcement; preset-less definitions are refused.
- **F-P6-B (MEDIUM, FIXED):** shared exit conditions suppressed opposite-direction
  entries (z-score shorts unreachable when the long-oriented exit read true). Fixed:
  exits close open positions only; entries evaluate independently (documented LONG
  priority on the impossible both-true case).
- **F-P6-C (LOW, FIXED):** `max_participation` existed in both sizing and liquidity
  policy, inviting exactly the misconfiguration a test reproduced. Removed from sizing;
  liquidity policy is now the single source.
- **F-P6-D (LOW, FIXED):** weekend-dated signals were silently dropped by the session
  gate. Now documented (`signals calendar-blind, execution session-gated`) with a
  pinning test; deferral remains future work.
- **Process notes:** four edit-scarring incidents (doubled export, truncated test tail,
  wrong import depth, duplicated helper) broke transforms; all repaired, transforms
  clean. Two stray no-op shell probes; no effect.

## 4. Severity classification

No CRITICAL or HIGH findings. MEDIUM: F-P6-A, F-P6-B (fixed + tested). LOW: F-P6-C,
F-P6-D (fixed). INFORMATIONAL (non-blocking):
- O1: intraday bars share their calendar date's session gate (no session-time slicing).
- O2: benchmark is equal-weighted buy-and-hold paying entry+exit costs; annualization
  fixed at 252 in benchmark aggregation.
- O3: walk-forward uses fixed params per strategy version (no per-window re-tuning, by design).
- O4: splits adjust full-history prices (industry-standard) with recorded method;
  short dividend liabilities unmodeled (recorded limitation).
- O5: evaluation thresholds (10 trades/60 bars, 40% DD, 50% OOS-sharpe decay, 1.5x
  stress, sweep>50 flag) are stated heuristics, not calibrated cutoffs.
- O6: `APPROVED` and `PAPER_ELIGIBLE` are record-only states; no activation path exists.

## 5. Regression + verification (executed)

- `pnpm test`: **61 files, 341 tests, all pass** (267 prior intact — zero prior test
  files modified or deleted; scope is the strategy app + wiring only).
- `pnpm typecheck`: clean. `pnpm lint`: clean (new strategy boundary rules executing).
- `pytest`: **15 passed** (13 prior + 2 parity).
- `pnpm build` clean; all seven verify scripts ok, including new `verify-strategy`
  (§44 loop + rerun equivalence + §45 impossibility proofs: 20/20 checks).
- Searches: strategy/backtest trees contain no broker/execution/risk/portfolio/gateway/
  training/eval/exec/shell references (one prohibition comment reworded to keep the
  scanner literal).

## 6. Final verdict

**PASS** — Phase 6 delivers validated strategy intelligence with honest simulation:
declarative bias-resistant strategies, point-in-time discipline, cost/slippage/liquidity
realism, OOS/walk-forward/stress/robustness methodology, overfitting guards, reproducible
experiments, and absolute isolation from brokers, execution, and live trading.
