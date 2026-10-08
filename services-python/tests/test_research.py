"""Phase 5 parity: Python research-contract mirror agrees with the TS engine."""

from aurix_py.research import FORBIDDEN_TRADE_FIELDS, check_agent_result


def _valid_result(**over):
    base = {
        "research_task_id": "t", "agent": "fundamental", "subject": "company:TCS",
        "status": "COMPLETED", "observations": [], "evidence": [], "sources": [],
        "methodology": "m", "assumptions": [], "contradictions": [],
        "conclusions": [], "confidence": 0.7, "knowledge_proposals": [],
        "missing": [], "created_at": 1, **over,
    }
    return base


def test_valid_result_passes():
    assert check_agent_result(_valid_result()) == []


def test_missing_fields_and_bad_status_flagged():
    violations = check_agent_result({"status": "GUESSING"})
    assert any(v.startswith("missing:") for v in violations)
    assert any(v.startswith("bad-status:") for v in violations)


def test_trade_fields_forbidden():
    assert check_agent_result(_valid_result(order={})) != []
    assert "order" in FORBIDDEN_TRADE_FIELDS
    assert "leverage" in FORBIDDEN_TRADE_FIELDS
