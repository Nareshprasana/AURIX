"""Phase 6 parity: Python strategy mirrors agree with the TS engine."""

from aurix_py.strategy import (
    BACKTEST_STATUS,
    EVALUATION_LABELS,
    SIGNAL_TYPES,
    STRATEGY_STATUS,
    transition_allowed,
)


def test_vocabularies():
    assert len(STRATEGY_STATUS) == 11
    assert SIGNAL_TYPES == {"LONG", "SHORT", "EXIT", "HOLD", "NO_SIGNAL", "INVALID"}
    assert "ROBUST" in EVALUATION_LABELS
    assert "DATA_QUARANTINED" in BACKTEST_STATUS


def test_lifecycle_mirror():
    assert transition_allowed("CANDIDATE", "BACKTESTED") is True
    assert transition_allowed("CANDIDATE", "OOS_VALIDATED") is False
    assert transition_allowed("BACKTESTED", "REJECTED") is True
    assert transition_allowed("REJECTED", "CANDIDATE") is False
    assert transition_allowed("DEGRADED", "CANDIDATE") is True
    assert transition_allowed("REJECTED", "DEGRADED") is False
