"""Memory freshness + data-quality parity mirrors (Phase 4).

TypeScript governs; these mirrors keep Python analytic code aligned.
No writers, no network, no broker code here.
"""

MEMORY_FRESHNESS_MS = {
    "price": (60_000, 300_000),
    "quote": (60_000, 300_000),
    "intraday": (15 * 60_000, 60 * 60_000),
    "fundamentals": (90 * 86_400_000, 180 * 86_400_000),
    "corporate-event": (86_400_000, 7 * 86_400_000),
    "static": (365 * 86_400_000, 730 * 86_400_000),
    "research": (7 * 86_400_000, 30 * 86_400_000),
    "default": (86_400_000, 7 * 86_400_000),
}


def classify_memory_age(domain: str, age_ms) -> str:
    """Mirrors classifyMemoryAge: FRESH/AGING/STALE/UNKNOWN."""
    if age_ms is None or not isinstance(age_ms, (int, float)) or age_ms != age_ms or age_ms < 0:
        return "UNKNOWN"
    fresh, aging = MEMORY_FRESHNESS_MS.get(domain, MEMORY_FRESHNESS_MS["default"])
    if age_ms <= fresh:
        return "FRESH"
    if age_ms <= aging:
        return "AGING"
    return "STALE"


def assess_record(record: dict, *, now: int, ref_price=None, last_ts=None) -> dict:
    """Minimal quality-verdict mirror: VALID/SUSPECT/QUARANTINED + reasons."""
    reasons = []
    quarantine = []
    suspect = []
    ts = record.get("ts")
    if not isinstance(ts, (int, float)) or ts <= 0:
        quarantine.append("invalid timestamp")
    if isinstance(ts, (int, float)) and ts > now + 60_000:
        quarantine.append("future timestamp")
    if last_ts is not None and isinstance(ts, (int, float)) and ts <= last_ts:
        quarantine.append("out-of-order record")
    for field in ("open", "high", "low", "close", "price", "volume"):
        value = record.get(field)
        if value is None:
            continue
        if not isinstance(value, (int, float)):
            quarantine.append(f"invalid {field}")
        elif value < 0:
            quarantine.append(f"negative {field}")
    reasons = quarantine + suspect
    verdict = "QUARANTINED" if quarantine else ("SUSPECT" if suspect else "VALID")
    _ = ref_price
    return {"verdict": verdict, "reasons": reasons}
