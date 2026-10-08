"""Phase 1 Python smoke + contract parity (TS is safety owner; Python must agree)."""

from aurix_py import VALID_ELIGIBILITY, VALID_MODES, generic_instrument, is_tradable


def test_eligibility_fail_closed():
    assert is_tradable("LEGAL") is True
    for s in ["RESTRICTED", "UNAVAILABLE", "UNKNOWN", ""]:
        assert is_tradable(s) is False


def test_generic_instrument_has_no_venue_branches():
    inst = generic_instrument("NSE", "equity", "EQ", "RELIANCE")
    assert inst["exchange"] == "NSE"
    assert set(inst) == {"exchange", "market", "segment", "symbol"}
    assert "LEGAL" in VALID_ELIGIBILITY
    assert "RESEARCH" in VALID_MODES
