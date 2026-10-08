"""AURIX Python workspace — Phase 1 stubs only.

No production collectors/research/strategy/training here (Phases 3+).
This module holds schema-parity helpers shared with the TS contracts.
"""

VALID_ELIGIBILITY = {"LEGAL", "RESTRICTED", "UNAVAILABLE", "UNKNOWN"}
VALID_MODES = {"RESEARCH", "BACKTEST", "SHADOW", "PAPER", "CONTROLLED_LIVE", "AUTONOMOUS_LIVE"}


def is_tradable(eligibility: str) -> bool:
    """UNKNOWN is fail-closed: only LEGAL is tradable."""
    return eligibility == "LEGAL"


def generic_instrument(exchange: str, market: str, segment: str, symbol: str) -> dict:
    return {"exchange": exchange, "market": market, "segment": segment, "symbol": symbol}
