"""Typed AI failures. Every failure mode fails safe: no activation, no live
trading, no store corruption. Callers map these to SAFE responses."""

from __future__ import annotations


class AITrainingError(Exception):
    code: str = "AI_ERROR"

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def fail(code: str, message: str) -> AITrainingError:
    return AITrainingError(code, message)


KNOWN_FAILURES = frozenset({
    "DATASET_MISSING", "DATASET_CORRUPT", "INVALID_FEATURE", "INVALID_LABEL",
    "INSUFFICIENT_SAMPLES", "GPU_UNAVAILABLE", "CUDA_UNAVAILABLE", "GPU_OOM",
    "CHECKPOINT_CORRUPT", "TRAINING_INTERRUPTED", "INVALID_CONFIG",
    "INCOMPATIBLE_ARTIFACT", "OLLAMA_UNAVAILABLE", "QWEN_UNAVAILABLE",
    "LAYA_UNAVAILABLE",
})
