"""Explicit AI signal interfaces. The three outputs are NOT interchangeable.

- MarketModelPrediction: numerical quant output (probability of positive forward return).
- LayaDecisionSignal: fast System-1 structured decision support.
- LLMReasoningResult: Qwen qualitative reasoning/synthesis (never authoritative).

Every record carries evidence refs + producer versions so AURIX can always answer
what each layer said, what supported it, and what the deterministic layers decided.
Secrets are rejected from all prompt/evidence content at construction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

SECRET_RE = re.compile(r"api[_-]?key|secret|token|password|private[_-]?key|kite", re.I)


def assert_no_secrets(where: str, text: str) -> None:
    if SECRET_RE.search(text or ""):
        raise ValueError(f"SECRET_REJECTED in {where}: refusing to embed secret-shaped content")


@dataclass(frozen=True)
class MarketModelPrediction:
    model_id: str
    model_version: str
    dataset_version: str
    instrument: str
    as_of: int
    probability_up: float
    threshold: float
    signal: str  # UP | DOWN | NO_SIGNAL
    evidence_refs: tuple = ()
    trace_id: str = ""


@dataclass(frozen=True)
class LayaDecisionSignal:
    laya_version: str
    instrument: str
    as_of: int
    decision: str
    confidence: float
    questions: tuple = ()
    evidence_refs: tuple = ()
    trace_id: str = ""
    device: str = "cpu"


@dataclass(frozen=True)
class LLMReasoningResult:
    provider: str
    model: str
    prompt_name: str
    prompt_version: str
    caller: str
    trace_id: str
    text: str
    latency_ms: int
    evidence_refs: tuple = ()

    def __post_init__(self) -> None:
        assert_no_secrets("LLMReasoningResult.text", self.text)


def knowledge_observation(kind: str, refs: dict) -> dict:
    """Shape an AI output as an import-ready AURIX knowledge OBSERVATION record
    (returned, never auto-committed — governance owns the write path)."""
    return {"assertion": "OBSERVATION", "kind": kind, "refs": refs}
