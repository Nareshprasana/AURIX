"""Portfolio parity (Phase 7): decision states, allocators, limits mirrors.

TypeScript governs; these mirrors keep Python analytic code aligned.
No writers, no trading fields, no broker code here.
"""

RISK_VERDICTS = frozenset({"ALLOW", "REDUCE", "REJECT", "UNKNOWN"})
DRAWDOWN_STATES = ("NORMAL", "CAUTION", "RESTRICTED", "HALTED")
ALLOCATORS = ("equal", "signal", "risk", "volatility", "confidence", "hybrid")
REBALANCE_INTENTS = frozenset({"BUY", "SELL", "REDUCE", "INCREASE", "HOLD", "NO_CHANGE", "BLOCKED"})

# Phase 1 safety defaults mirrored for cross-checks (authoritative copy is TS).
LIMITS = {
    "max_position_pct": 2.0,
    "max_gross_pct": 60.0,
    "max_sector_pct": 20.0,
    "max_leverage": 1.0,
    "max_margin_pct": 50.0,
    "max_daily_loss_pct": 1.5,
    "max_drawdown_pct": 8.0,
    "liquidity_max_adv_pct": 5.0,
    "liquidity_max_spread_bps": 50,
    "concentration_top5_pct": 40.0,
}


def drawdown_state(drawdown_pct: float, daily_loss_pct: float) -> str:
    """Mirrors the TS drawdown machine."""
    dd = abs(drawdown_pct)
    if dd >= LIMITS["max_drawdown_pct"] or daily_loss_pct >= LIMITS["max_daily_loss_pct"]:
        return "HALTED"
    if dd >= 6.0:
        return "RESTRICTED"
    if dd >= 4.0:
        return "CAUTION"
    return "NORMAL"


def risk_wins(allocator_pct: float, risk_cap_pct: float) -> float:
    """Final allocation is the minimum of allocator desire and risk cap."""
    return min(allocator_pct, risk_cap_pct)
