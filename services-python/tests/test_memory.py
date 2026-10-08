"""Phase 4 parity: Python memory/quality mirrors agree with the TS engine."""

from aurix_py.memory import MEMORY_FRESHNESS_MS, assess_record, classify_memory_age


def test_freshness_mirror():
    assert classify_memory_age("price", 1_000) == "FRESH"
    assert classify_memory_age("price", 600_000) == "STALE"
    assert classify_memory_age("static", 600_000) == "FRESH"
    assert classify_memory_age("price", None) == "UNKNOWN"
    assert classify_memory_age("price", -5) == "UNKNOWN"
    assert set(MEMORY_FRESHNESS_MS) >= {"price", "fundamentals", "static", "research", "default"}


def test_quality_verdict_mirror():
    assert assess_record({"ts": 100}, now=200)["verdict"] == "VALID"
    bad = assess_record({"ts": 100, "close": -4}, now=200)
    assert bad["verdict"] == "QUARANTINED"
    assert any("negative" in r for r in bad["reasons"])
    assert assess_record({"ts": -1}, now=200)["verdict"] == "QUARANTINED"
