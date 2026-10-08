"""Phase 3 parity: Python sync-protocol mirror agrees with the TS engine."""

from aurix_py.sync_proto import (
    CONFLICT_CLASSES,
    RESOLUTION_ACTIONS,
    check_schema_compat,
    triage_vectors,
)


def test_conflict_and_resolution_vocabularies():
    assert len(CONFLICT_CLASSES) == 8
    assert "CONTRADICTORY" in CONFLICT_CLASSES
    assert RESOLUTION_ACTIONS == ("UNRESOLVED", "ACCEPT_A", "ACCEPT_B", "MERGE", "KEEP_BOTH", "REJECT_BOTH")


def test_compat_mirror():
    assert check_schema_compat("graph-v1", "graph-v1") == "COMPATIBLE"
    assert check_schema_compat("graph-v1", "graph-v2") == "UPGRADE_REQUIRED"
    assert check_schema_compat("graph-v3", "graph-v2") == "UNSUPPORTED"


def test_triage_mirror():
    assert triage_vectors({"a": 80}, {"a": 100}) == "BEHIND"
    assert triage_vectors({"a": 80, "b": 82}, {"a": 80, "c": 84}) == "DIVERGED"
    assert triage_vectors({"a": 80}, {"a": 80}) == "IN_SYNC"
