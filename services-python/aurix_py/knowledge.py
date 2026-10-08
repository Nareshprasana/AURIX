"""AURIX knowledge-policy parity (Phase 2).

The TypeScript knowledge-service governs; this module mirrors the FACT-promotion
and label-discipline rules so Python analytic code agrees with the safety path.
No graph writers live here — Python analytic services must never mutate the graph.
"""

LABELS = frozenset({"FACT", "OBSERVATION", "INFERENCE", "HYPOTHESIS", "PREDICTION", "UNKNOWN"})
LIFECYCLE = ("PROPOSED", "VALIDATING", "VALIDATED", "REJECTED")
AUTHORITATIVE_SOURCES = frozenset({"exchange-filing", "regulator", "audited-statement"})
MIN_INDEPENDENT_SOURCES = 2


def downgrade_for_llm(assertion: str, source_type: str) -> str:
    """Bare LLM FACT claims default to INFERENCE (mirrors policy.ts)."""
    if assertion == "FACT" and source_type == "llm":
        return "INFERENCE"
    return assertion


def can_promote_to_fact(source_type: str, independent_sources: int) -> bool:
    """Mirrors policy.ts canPromoteToFact."""
    if source_type in AUTHORITATIVE_SOURCES:
        return True
    return independent_sources >= MIN_INDEPENDENT_SOURCES
