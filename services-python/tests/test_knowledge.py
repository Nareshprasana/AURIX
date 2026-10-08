"""Phase 2 parity: Python knowledge-policy mirror agrees with the TS service."""

from aurix_py.knowledge import (
    LABELS,
    LIFECYCLE,
    MIN_INDEPENDENT_SOURCES,
    can_promote_to_fact,
    downgrade_for_llm,
)


def test_labels_cover_all_assertion_types():
    assert LABELS == {"FACT", "OBSERVATION", "INFERENCE", "HYPOTHESIS", "PREDICTION", "UNKNOWN"}
    assert LIFECYCLE == ("PROPOSED", "VALIDATING", "VALIDATED", "REJECTED")


def test_llm_fact_downgraded():
    assert downgrade_for_llm("FACT", "llm") == "INFERENCE"
    assert downgrade_for_llm("FACT", "press") == "FACT"
    assert downgrade_for_llm("HYPOTHESIS", "llm") == "HYPOTHESIS"


def test_fact_promotion_rule():
    assert can_promote_to_fact("exchange-filing", 1) is True
    assert can_promote_to_fact("press", 1) is False
    assert can_promote_to_fact("press", MIN_INDEPENDENT_SOURCES) is True
    assert can_promote_to_fact("llm", 5) is True  # count rule only; TS downgrades first
