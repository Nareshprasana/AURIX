"""Sync-protocol parity (Phase 3): conflict classes, compat and triage mirrors.

The TypeScript sync-manager governs; these mirrors keep Python analytic code
aligned. No writers, no crypto, no transport code here.
"""

CONFLICT_CLASSES = frozenset({
    "IDENTICAL", "DUPLICATE", "NON_CONFLICTING", "CONCURRENT",
    "CONTRADICTORY", "SCHEMA_CONFLICT", "TRUST_CONFLICT", "VERSION_CONFLICT",
})
RESOLUTION_ACTIONS = ("UNRESOLVED", "ACCEPT_A", "ACCEPT_B", "MERGE", "KEEP_BOTH", "REJECT_BOTH")


def _major(version: str) -> int:
    import re

    m = re.search(r"-v(\d+)(?:\.|$)", version)
    return int(m.group(1)) if m else 0


def check_schema_compat(sender_schema: str, local_schema: str) -> str:
    s, local = _major(sender_schema), _major(local_schema)
    if s == local and s != 0:
        return "COMPATIBLE"
    if s != 0 and local != 0 and s < local:
        return "UPGRADE_REQUIRED"
    return "UNSUPPORTED"


def triage_vectors(local: dict, remote: dict) -> str:
    remote_ahead = any(remote.get(d, 0) > local.get(d, 0) for d in set(local) | set(remote))
    local_ahead = any(local.get(d, 0) > remote.get(d, 0) for d in set(local) | set(remote))
    if remote_ahead and not local_ahead:
        return "BEHIND"
    if local_ahead and not remote_ahead:
        return "AHEAD"
    if not remote_ahead and not local_ahead:
        return "IN_SYNC"
    return "DIVERGED"
