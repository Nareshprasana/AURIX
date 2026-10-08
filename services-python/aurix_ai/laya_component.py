"""Laya System-1 component: version/API probe, real Agent inference (lazy, CPU,
timeout-guarded), and a calibration-fit operation from the installed API.

Laya never touches brokers, risk, execution, or secrets. Its signals are
advisory only and stay subordinate to Portfolio -> Risk -> Safety Gate.
"""

from __future__ import annotations

import time

from .errors import fail
from .signals import LayaDecisionSignal

REQUIRED_API = ("decide", "Agent", "confidence_from_probs", "fit_temperature_map")


def probe_laya() -> dict:
    """Inspect the INSTALLED laya package (never assume its API)."""
    try:
        import laya  # type: ignore
    except Exception as e:
        raise fail("LAYA_UNAVAILABLE", f"import failed: {e}")
    version = getattr(laya, "__version__", "unknown")
    import sys
    caps = {name: callable(getattr(laya, name, None)) for name in REQUIRED_API}
    try:
        import torch  # type: ignore
        torch_cuda = bool(torch.cuda.is_available())
        torch_version = str(torch.__version__)
    except Exception:
        torch_cuda, torch_version = False, None
    return {"laya_version": version, "python": sys.version.split()[0],
            "capabilities": caps, "torch_version": torch_version,
            "torch_cuda": torch_cuda,
            "has_train_cli": _has_cli("laya-train")}


def _has_cli(name: str) -> bool:
    import shutil
    return shutil.which(name) is not None


def run_decision(state: str, questions: dict, device: str = "cpu",
                 timeout_note: str = "") -> LayaDecisionSignal:
    """Real Laya Agent inference. Downloads the checkpoint on first use; CPU default
    to respect the shared 4 GB GPU budget (Ollama serves Qwen there)."""
    t0 = time.time()
    try:
        import laya  # type: ignore
    except Exception as e:
        raise fail("LAYA_UNAVAILABLE", f"import failed: {e}")
    try:
        agent = laya.Agent(device=device if device in ("cpu", "cuda") else "cpu")
        out = agent.predict(state, questions)
    except Exception as e:
        raise fail("LAYA_UNAVAILABLE", f"agent inference failed: {e}")
    conf = 0.0
    try:
        first = next(iter(out.values())) if isinstance(out, dict) else None
        if isinstance(first, dict) and "confidence" in first:
            conf = float(first["confidence"])
    except Exception:
        conf = 0.0
    return LayaDecisionSignal(
        laya_version=getattr(laya, "__version__", "unknown"),
        instrument=str(state)[:64], as_of=int(time.time() * 1000),
        decision=str(out)[:500], confidence=conf,
        questions=tuple(sorted(questions.keys())),
        trace_id=f"laya-{int(t0 * 1000)}", device=device)


def calibration_fit(probas: list, labels: list, seed: int = 7) -> dict:
    """Real fitting operation from the installed API (temperature/binning maps)."""
    try:
        import laya  # type: ignore
    except Exception as e:
        raise fail("LAYA_UNAVAILABLE", f"import failed: {e}")
    import numpy as np
    recs = []
    for p, y in zip(probas, labels):
        p = min(max(float(p), 1e-6), 1.0 - 1e-6)
        recs.append((0, [float(np.log(1.0 - p)), float(np.log(p))],
                        [1.0, 0.0] if int(y) == 0 else [0.0, 1.0]))
    out = laya.fit_temperature_map(recs, seed=seed)
    if not isinstance(out, dict) or not out:
        raise fail("LAYA_UNAVAILABLE", "calibration fit returned empty result")
    return out
