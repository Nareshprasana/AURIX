"""Research-contract parity (Phase 5): status vocabulary + output field rules.

TypeScript governs; these mirrors keep Python analytic code aligned.
No writers, no trading fields, no broker code here.
"""

RESEARCH_STATUS = frozenset({
    "COMPLETED", "PARTIAL", "INSUFFICIENT_DATA", "CONFLICTED",
    "SOURCE_UNAVAILABLE", "DATA_QUARANTINED", "MODEL_UNAVAILABLE",
    "TIMEOUT", "FAILED",
})

REQUIRED_AGENT_RESULT_FIELDS = frozenset({
    "research_task_id", "agent", "subject", "status", "observations",
    "evidence", "sources", "methodology", "assumptions", "contradictions",
    "conclusions", "confidence", "knowledge_proposals", "missing", "created_at",
})

FORBIDDEN_TRADE_FIELDS = frozenset({"order", "position", "leverage", "allocation", "buy", "sell"})


def check_agent_result(result: dict) -> list:
    """Return contract violations (empty = compliant)."""
    missing = [f for f in REQUIRED_AGENT_RESULT_FIELDS if f not in result]
    forbidden = [f for f in FORBIDDEN_TRADE_FIELDS if f in result]
    bad_status = [] if result.get("status") in RESEARCH_STATUS else [result.get("status")]
    return [f"missing:{m}" for m in missing] + [f"forbidden:{f}" for f in forbidden] + [f"bad-status:{s}" for s in bad_status]
