"""AURIX AI layer — resource-aware device selection for the 4 GB GPU box.

No broker, no secrets, no execution imports. Pure stdlib detection plus an
optional torch probe (guarded: torch may be absent).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ResourceReport:
    os: str
    gpu_present: bool
    gpu_name: str | None
    vram_total_mb: int | None
    vram_used_mb: int | None
    cuda_driver: str | None
    torch_version: str | None
    torch_cuda_available: bool
    device_selected: str
    reason: str


def _nvidia_smi() -> dict | None:
    if shutil.which("nvidia-smi") is None:
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,driver_version",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15,
        )
        if out.returncode != 0:
            return None
        parts = [p.strip() for p in out.stdout.strip().split(",")]
        if len(parts) < 4:
            return None
        return {"name": parts[0], "total_mb": int(float(parts[1])),
                "used_mb": int(float(parts[2])), "driver": parts[3]}
    except Exception:
        return None


def _torch_probe() -> tuple[str | None, bool]:
    try:
        import torch  # type: ignore
        try:
            cuda = bool(torch.cuda.is_available())
        except Exception:
            cuda = False
        return (str(torch.__version__), cuda)
    except Exception:
        return (None, False)


def detect_resources() -> ResourceReport:
    """Detect compute resources. Never raises for missing GPU/torch."""
    import platform
    smi = _nvidia_smi()
    torch_version, torch_cuda = _torch_probe()
    return ResourceReport(
        os=platform.system(),
        gpu_present=smi is not None,
        gpu_name=smi["name"] if smi else None,
        vram_total_mb=smi["total_mb"] if smi else None,
        vram_used_mb=smi["used_mb"] if smi else None,
        cuda_driver=smi["driver"] if smi else None,
        torch_version=torch_version,
        torch_cuda_available=torch_cuda,
        device_selected="cpu",
        reason="detection only; call select_device() for policy",
    )


def select_device(policy: str = "auto", vram_budget_mb: int = 1024,
                  report: ResourceReport | None = None) -> ResourceReport:
    """Apply the device policy. `auto` uses CUDA only when torch-CUDA works AND
    observed free VRAM covers the budget; otherwise CPU fallback (never OOM-force)."""
    rep = report or detect_resources()
    if policy == "cpu":
        return ResourceReport(**{**rep.__dict__, "device_selected": "cpu",
                                 "reason": "policy=cpu (explicit fallback)"})
    if policy == "cuda":
        if rep.torch_cuda_available:
            return ResourceReport(**{**rep.__dict__, "device_selected": "cuda",
                                     "reason": "policy=cuda and torch-CUDA available"})
        return ResourceReport(**{**rep.__dict__, "device_selected": "cpu",
                                 "reason": "policy=cuda requested but torch-CUDA unavailable; CPU fallback"})
    # auto
    if rep.torch_cuda_available and rep.vram_total_mb:
        free_mb = rep.vram_total_mb - (rep.vram_used_mb or 0)
        if free_mb >= vram_budget_mb:
            return ResourceReport(**{**rep.__dict__, "device_selected": "cuda",
                                     "reason": f"auto: free VRAM {free_mb}MB >= budget {vram_budget_mb}MB"})
        return ResourceReport(**{**rep.__dict__, "device_selected": "cpu",
                                 "reason": f"auto: free VRAM {free_mb}MB < budget {vram_budget_mb}MB; CPU fallback"})
    reasons = []
    if not rep.torch_cuda_available:
        reasons.append("torch-CUDA unavailable")
    if not rep.gpu_present:
        reasons.append("no GPU detected")
    return ResourceReport(**{**rep.__dict__, "device_selected": "cpu",
                             "reason": "auto: " + "; ".join(reasons) + "; CPU fallback"})
