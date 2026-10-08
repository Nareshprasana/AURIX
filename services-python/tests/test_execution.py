"""Phase 8 execution parity tests: states, transitions, retry classes, live containment."""

from aurix_py.execution import (
    AUTONOMOUS_LIVE_ENABLED,
    LEGAL_TRANSITIONS,
    ORDER_STATES,
    TERMINAL_STATES,
    classify_retry,
    is_autonomous_live_enabled,
    transition_allowed,
)


def test_order_states_count():
    assert len(ORDER_STATES) == 15
    assert "UNKNOWN" in ORDER_STATES
    assert "RECONCILING" in ORDER_STATES
    assert "RECONCILED" in ORDER_STATES


def test_unknown_must_reconcile():
    assert transition_allowed("UNKNOWN", "RECONCILING")
    assert not transition_allowed("UNKNOWN", "FILLED")
    assert not transition_allowed("UNKNOWN", "REJECTED")
    assert not transition_allowed("SUBMITTED", "FILLED")


def test_terminal_states_have_no_outgoing():
    for s in TERMINAL_STATES:
        assert LEGAL_TRANSITIONS[s] == set(), s


def test_retry_classes():
    assert classify_retry("TIMEOUT") == "RECONCILE_FIRST"
    assert classify_retry("RATE_LIMIT") == "RECONCILE_FIRST"
    assert classify_retry("OUTAGE") == "RECONCILE_FIRST"
    assert classify_retry("MALFORMED_RESPONSE") == "DO_NOT_RETRY"
    assert classify_retry("BROKER_REJECTION") == "DO_NOT_RETRY"
    assert classify_retry("PERMISSION") == "DO_NOT_RETRY"


def test_autonomous_live_disabled():
    assert AUTONOMOUS_LIVE_ENABLED is False
    assert is_autonomous_live_enabled() is False
