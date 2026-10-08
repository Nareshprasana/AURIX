"""Execution parity (Phase 8): order states, retry classes, live containment mirrors.

TypeScript governs; these mirrors keep Python analytic code aligned.
No writers, no trading fields, no broker code here.
"""

ORDER_STATES = frozenset({
    "CREATED", "VALIDATING", "REJECTED", "APPROVED", "SUBMITTED",
    "ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED",
    "CANCELLED", "EXPIRED", "BROKER_REJECTED", "UNKNOWN",
    "RECONCILING", "RECONCILED",
})

TERMINAL_STATES = frozenset({
    "REJECTED", "FILLED", "CANCELLED", "EXPIRED", "BROKER_REJECTED", "RECONCILED",
})

LEGAL_TRANSITIONS = {
    "CREATED": {"VALIDATING"},
    "VALIDATING": {"REJECTED", "APPROVED"},
    "REJECTED": set(),
    "APPROVED": {"SUBMITTED", "REJECTED", "EXPIRED"},
    "SUBMITTED": {"ACKNOWLEDGED", "BROKER_REJECTED", "UNKNOWN", "EXPIRED", "RECONCILING"},
    "ACKNOWLEDGED": {"PARTIALLY_FILLED", "FILLED", "BROKER_REJECTED", "CANCEL_REQUESTED", "EXPIRED", "UNKNOWN", "RECONCILING"},
    "PARTIALLY_FILLED": {"PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED", "EXPIRED", "UNKNOWN", "RECONCILING"},
    "FILLED": set(),
    "CANCEL_REQUESTED": {"CANCELLED", "FILLED", "PARTIALLY_FILLED", "UNKNOWN", "RECONCILING"},
    "CANCELLED": set(),
    "EXPIRED": set(),
    "BROKER_REJECTED": set(),
    "UNKNOWN": {"RECONCILING"},
    "RECONCILING": {"RECONCILED", "UNKNOWN"},
    "RECONCILED": set(),
}

RETRY_CLASSES = frozenset({"SAFE_RETRY", "RECONCILE_FIRST", "DO_NOT_RETRY"})

# AUTONOMOUS_LIVE must remain DISABLED in Phase 8.
AUTONOMOUS_LIVE_ENABLED = False


def transition_allowed(frm: str, to: str) -> bool:
    """Mirrors the TS lifecycle guard exactly."""
    if frm == to:
        return False
    return to in LEGAL_TRANSITIONS.get(frm, set())


def classify_retry(code: str) -> str:
    """Mirrors TS classifyRetry: ambiguous -> RECONCILE_FIRST, invalid -> DO_NOT_RETRY."""
    if code in {"TIMEOUT", "CONNECTION_RESET", "DNS_FAILURE", "PARTIAL_RESPONSE", "HTTP_5XX", "RATE_LIMIT", "OUTAGE", "UNKNOWN"}:
        return "RECONCILE_FIRST"
    return "DO_NOT_RETRY"


def is_autonomous_live_enabled() -> bool:
    return False
