"""Phase 7 parity: Python portfolio mirrors agree with the TS engine."""

from aurix_py.portfolio import (
    ALLOCATORS,
    DRAWDOWN_STATES,
    LIMITS,
    REBALANCE_INTENTS,
    RISK_VERDICTS,
    drawdown_state,
    risk_wins,
)


def test_vocabularies():
    assert RISK_VERDICTS == {"ALLOW", "REDUCE", "REJECT", "UNKNOWN"}
    assert DRAWDOWN_STATES == ("NORMAL", "CAUTION", "RESTRICTED", "HALTED")
    assert set(ALLOCATORS) == {"equal", "signal", "risk", "volatility", "confidence", "hybrid"}
    assert "BLOCKED" in REBALANCE_INTENTS
    assert LIMITS["max_position_pct"] == 2.0
    assert LIMITS["max_drawdown_pct"] == 8.0


def test_drawdown_and_risk_wins_mirrors():
    assert drawdown_state(1.0, 0.0) == "NORMAL"
    assert drawdown_state(5.0, 0.0) == "CAUTION"
    assert drawdown_state(7.0, 0.0) == "RESTRICTED"
    assert drawdown_state(8.0, 0.0) == "HALTED"
    assert drawdown_state(0.0, 1.5) == "HALTED"
    assert risk_wins(8.0, 2.0) == 2.0
    assert risk_wins(1.0, 2.0) == 1.0
