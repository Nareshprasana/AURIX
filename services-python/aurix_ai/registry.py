"""Model registry with explicit governance. New models enter as CANDIDATE and
can NEVER auto-activate. Promotion requires an explicit operator call."""

from __future__ import annotations

import json
import os
import time

from .errors import fail

STATES = ("CANDIDATE", "VALIDATED", "PAPER", "APPROVED", "ACTIVE", "RETIRED", "REJECTED")
ALLOWED = {
    "CANDIDATE": ("VALIDATED", "REJECTED"),
    "VALIDATED": ("PAPER", "REJECTED"),
    "PAPER": ("APPROVED", "REJECTED"),
    "APPROVED": ("ACTIVE", "REJECTED"),
    "ACTIVE": ("RETIRED",),
    "RETIRED": (),
    "REJECTED": (),
}


class ModelRegistry:
    def __init__(self, path: str):
        self.path = path
        self._load()

    def _load(self):
        if os.path.exists(self.path):
            with open(self.path) as f:
                self.models = json.load(f)
        else:
            self.models = {}

    def _save(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w") as f:
            json.dump(self.models, f, indent=2, sort_keys=True)

    def register(self, model_id: str, run_id: str, artifact_sha256: str,
                 operator: str) -> dict:
        if model_id in self.models:
            raise fail("INVALID_CONFIG", f"model exists: {model_id}")
        rec = {"model_id": model_id, "state": "CANDIDATE", "run_id": run_id,
               "artifact_sha256": artifact_sha256, "history": [
                   {"to": "CANDIDATE", "operator": operator, "at": int(time.time()),
                    "reason": "registered from training run"}]}
        self.models[model_id] = rec
        self._save()
        return rec

    def promote(self, model_id: str, to: str, operator: str, reason: str) -> dict:
        rec = self.models.get(model_id)
        if rec is None:
            raise fail("INVALID_CONFIG", f"unknown model: {model_id}")
        if to not in ALLOWED.get(rec["state"], ()):
            raise fail("INVALID_CONFIG",
                       f"transition {rec['state']} -> {to} not permitted")
        rec["state"] = to
        rec["history"].append({"to": to, "operator": operator,
                               "at": int(time.time()), "reason": reason})
        self._save()
        return rec

    def active(self) -> list:
        return [m for m in self.models.values() if m["state"] == "ACTIVE"]
