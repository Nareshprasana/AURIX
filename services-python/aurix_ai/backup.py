"""Backup and restore verification for run registries and run metadata.

Copies registry.json + per-experiment metadata (experiment.json, manifests,
metrics, eval/governance/backtest JSON, events, research log) into a
versioned backup directory with a sha256 file manifest. Bulky weight files
(checkpoints/*.npz, artifacts) are recorded by hash but NOT copied unless
include_weights=True, so routine backups stay small; restore verifies
whatever is present.

Never touches production paths except reading them. Restore refuses to
overwrite an existing runs root unless allow_overwrite=True (tests use temp
dirs; production restores are operator-confirmed).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil

from .errors import fail

BACKUP_VERSION = "backup-v1"
METADATA_FILES = ("experiment.json", "manifest.json", "metrics.jsonl", "eval.json",
                  "governance.json", "backtest.json", "walkforward.json", "stress.json",
                  "backtest-run.json", "heartbeat.json", "events.jsonl",
                  "knowledge_refs.jsonl", "recovery.json")
ROOT_FILES = ("registry.json", "model-registry.json", "supervisor.pid")


def _sha_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def backup_runs(runs_root: str, dest_dir: str, include_weights: bool = False) -> dict:
    """Copy registry + experiment metadata to dest_dir. Returns the manifest."""
    if not os.path.isdir(runs_root):
        raise fail("DATASET_MISSING", f"runs root absent: {runs_root}")
    if os.path.exists(dest_dir) and os.listdir(dest_dir):
        raise fail("INVALID_CONFIG", f"backup destination not empty: {dest_dir}")
    os.makedirs(dest_dir, exist_ok=True)
    files: dict = {}
    weights: dict = {}

    def _copy(src: str, rel: str) -> None:
        dst = os.path.join(dest_dir, rel)
        os.makedirs(os.path.dirname(dst) or dest_dir, exist_ok=True)
        shutil.copy2(src, dst)
        files[rel] = _sha_file(dst)

    for name in ROOT_FILES:
        src = os.path.join(runs_root, name)
        if os.path.exists(src):
            _copy(src, name)
    for eid in sorted(os.listdir(runs_root)):
        edir = os.path.join(runs_root, eid)
        if not os.path.isdir(edir):
            continue
        for name in METADATA_FILES:
            src = os.path.join(edir, name)
            if os.path.exists(src):
                _copy(src, os.path.join(eid, name))
        if include_weights:
            for sub in ("checkpoints", "final"):
                sdir = os.path.join(edir, sub)
                if not os.path.isdir(sdir):
                    continue
                for fn in sorted(os.listdir(sdir)):
                    rel = os.path.join(eid, sub, fn)
                    _copy(os.path.join(sdir, fn), rel)
                    weights[rel] = files.pop(rel)
    manifest = {"backup_version": BACKUP_VERSION, "source": runs_root,
                "files": files, "weights": weights,
                "include_weights": include_weights}
    with open(os.path.join(dest_dir, "backup-manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    return manifest


def verify_backup(dest_dir: str) -> list:
    """Recompute every recorded hash. Returns human-readable problems (empty = OK)."""
    problems = []
    mpath = os.path.join(dest_dir, "backup-manifest.json")
    if not os.path.exists(mpath):
        return ["missing backup-manifest.json"]
    manifest = json.load(open(mpath))
    if manifest.get("backup_version") != BACKUP_VERSION:
        problems.append(f"unsupported backup version: {manifest.get('backup_version')}")
    for rel, digest in {**manifest.get("files", {}), **manifest.get("weights", {})}.items():
        p = os.path.join(dest_dir, rel)
        if not os.path.exists(p):
            problems.append(f"missing file: {rel}")
        elif _sha_file(p) != digest:
            problems.append(f"checksum mismatch: {rel}")
    return problems


def restore_backup(dest_dir: str, runs_root: str, allow_overwrite: bool = False) -> dict:
    """Restore a verified backup. Refuses non-empty destinations unless
    allow_overwrite=True. Never deletes: overwrite replaces files in place."""
    problems = verify_backup(dest_dir)
    if problems:
        raise fail("DATASET_MISSING", f"backup invalid: {problems[0]}")
    if os.path.exists(runs_root) and os.listdir(runs_root) and not allow_overwrite:
        raise fail("INVALID_CONFIG", f"refusing to overwrite non-empty runs root: {runs_root}")
    os.makedirs(runs_root, exist_ok=True)
    manifest = json.load(open(os.path.join(dest_dir, "backup-manifest.json")))
    restored = []
    for rel in {**manifest.get("files", {}), **manifest.get("weights", {})}:
        dst = os.path.join(runs_root, rel)
        os.makedirs(os.path.dirname(dst) or runs_root, exist_ok=True)
        shutil.copy2(os.path.join(dest_dir, rel), dst)
        restored.append(rel)
    # Re-verify what was written.
    for rel in restored:
        src_hash = _sha_file(os.path.join(dest_dir, rel))
        if _sha_file(os.path.join(runs_root, rel)) != src_hash:
            raise fail("DATASET_MISSING", f"restore mismatch: {rel}")
    return {"restored": sorted(restored), "runs_root": runs_root}
