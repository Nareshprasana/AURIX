"""AI registry, resources, and security-boundary tests."""

import pytest

from aurix_ai.errors import KNOWN_FAILURES
from aurix_ai.registry import ALLOWED, ModelRegistry, STATES
from aurix_ai.resources import select_device
from aurix_ai import signals


def test_registry_states_and_governance(tmp_path):
    db = str(tmp_path / "registry.json")
    reg = ModelRegistry(db)
    rec = reg.register("m1", "run-1", "sha1", "op")
    assert rec["state"] == "CANDIDATE"
    assert reg.active() == []
    # No skipping: CANDIDATE -> ACTIVE refused.
    with pytest.raises(Exception):
        reg.promote("m1", "ACTIVE", "op", "skip")
    reg.promote("m1", "VALIDATED", "op", "val ok")
    reg.promote("m1", "PAPER", "op", "paper ok")
    reg.promote("m1", "APPROVED", "op", "approved")
    assert reg.active() == []
    reg.promote("m1", "ACTIVE", "op", "go")
    assert len(reg.active()) == 1
    assert set(STATES) >= {"CANDIDATE", "VALIDATED", "PAPER", "APPROVED", "ACTIVE", "RETIRED", "REJECTED"}
    assert "ACTIVE" not in ALLOWED["CANDIDATE"]


def test_resources_cpu_fallback_never_crashes():
    rep = select_device("cpu")
    assert rep.device_selected == "cpu"
    auto = select_device("auto")
    assert auto.device_selected in ("cpu", "cuda")
    if auto.device_selected == "cpu":
        assert "fallback" in auto.reason.lower() or "unavailable" in auto.reason.lower() or "no gpu" in auto.reason.lower()


def test_signals_distinct_and_secret_scanned():
    assert signals.MarketModelPrediction.__name__ != signals.LayaDecisionSignal.__name__ != signals.LLMReasoningResult.__name__
    with pytest.raises(ValueError):
        signals.LLMReasoningResult(provider="ollama", model="qwen3:4b", prompt_name="p",
                                   prompt_version="v1", caller="t", trace_id="t",
                                   text="leaked api_key=XYZ", latency_ms=1)
    obs = signals.knowledge_observation("training-run", {"run_id": "r1"})
    assert obs["assertion"] == "OBSERVATION"


def test_ai_layer_has_no_broker_surface():
    import aurix_ai, os
    root = os.path.dirname(aurix_ai.__file__)
    bad = []
    for fn in os.listdir(root):
        if not fn.endswith(".py"):
            continue
        src = open(os.path.join(root, fn), encoding="utf-8").read()
        for pat in ("placeOrder", "BrokerPort", "broker-sim", "broker-kite",
                    "kiteconnect", "api_secret", "access_token", "execution-service",
                    "order-safety-gate", "risk-engine"):
            if pat in src:
                bad.append(f"{fn}::{pat}")
    assert bad == []
    assert "GPU_OOM" in KNOWN_FAILURES and "OLLAMA_UNAVAILABLE" in KNOWN_FAILURES
