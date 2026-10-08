"""Strategy/backtest parity (Phase 6): lifecycle, signals, evaluation labels.

TypeScript governs; these mirrors keep Python analytic code aligned.
No writers, no trading fields, no broker code here.
"""

STRATEGY_STATUS = frozenset({
    "HYPOTHESIS", "CANDIDATE", "BACKTESTED", "OOS_VALIDATED",
    "WALK_FORWARD_VALIDATED", "STRESS_TESTED", "PAPER_ELIGIBLE",
    "APPROVED", "REJECTED", "DEGRADED", "RETIRED",
})

SIGNAL_TYPES = frozenset({"LONG", "SHORT", "EXIT", "HOLD", "NO_SIGNAL", "INVALID"})

EVALUATION_LABELS = frozenset({
    "REJECTED", "WEAK", "PROMISING", "ROBUST", "DEGRADED",
    "INSUFFICIENT_DATA", "INVALID",
})

BACKTEST_STATUS = frozenset({
    "QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "INSUFFICIENT_DATA",
    "DATA_QUARANTINED", "INVALID", "FAILED", "CANCELLED",
})

# Forward-only lifecycle (plus terminal/degredation side transitions).
FORWARD_FLOW = [
    "HYPOTHESIS", "CANDIDATE", "BACKTESTED", "OOS_VALIDATED",
    "WALK_FORWARD_VALIDATED", "STRESS_TESTED", "PAPER_ELIGIBLE", "APPROVED",
]


def transition_allowed(frm: str, to: str) -> bool:
    """Mirrors the TS lifecycle guard exactly."""
    if frm == to:
        return True
    if frm in ("REJECTED", "RETIRED"):
        return False
    if to in ("REJECTED", "RETIRED", "DEGRADED"):
        return True
    if frm == "DEGRADED":
        return to in ("CANDIDATE", "REJECTED", "RETIRED")
    if frm not in FORWARD_FLOW or to not in FORWARD_FLOW:
        return False
    return FORWARD_FLOW.index(to) == FORWARD_FLOW.index(frm) + 1
