"""Versioned market datasets with mandatory no-look-ahead guarantees.

Pipeline: seeded OHLCV -> validation -> quality gate -> causal features ->
forward labels -> versioned immutable dataset -> chronological split.

Leakage rules enforced by construction + asserted by tests:
- features at bar T use closes/volumes at indices <= T only;
- labels may use closes at T+N (target definition only);
- scaler/normalization stats come from TRAIN rows only (see model.py);
- splits are chronological (train/val/test timestamp ranges never overlap).
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass

import numpy as np

from .errors import fail

FEATURE_COLUMNS = ("ret_1", "ret_2", "ret_3", "ret_4", "ret_5", "mom_10", "vol_10", "vol_ratio")
PREPROCESSING_VERSION = "prep-v1"
FEATURES_VERSION = "feat-v1"
LABEL_VERSION = "label-v1"


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    version: str
    instruments: tuple
    n_bars: int
    seed: int
    horizon_bars: int
    threshold: float
    start_ts: int
    bar_ms: int = 86_400_000


def generate_ohlcv(seed: int, n_bars: int, instruments: tuple,
                   start_ts: int, bar_ms: int = 86_400_000) -> dict:
    """Deterministic seeded geometric-Brownian OHLCV per instrument."""
    out = {}
    for i, inst in enumerate(instruments):
        rng = np.random.default_rng(seed * 100003 + i * 7919 + 11)
        rets = rng.normal(0.0004, 0.012, size=n_bars)
        close = 100.0 * np.cumprod(1.0 + rets)
        open_ = np.concatenate([[100.0], close[:-1]])
        high = np.maximum(open_, close) * (1.0 + np.abs(rng.normal(0, 0.003, n_bars)))
        low = np.minimum(open_, close) * (1.0 - np.abs(rng.normal(0, 0.003, n_bars)))
        volume = (1_000_000 * (1.0 + 0.5 * np.abs(rng.normal(0, 1, n_bars)))).astype(np.int64)
        ts = start_ts + np.arange(n_bars, dtype=np.int64) * bar_ms
        out[inst] = {"ts": ts, "open": open_, "high": high, "low": low,
                     "close": close, "volume": volume}
    return out


def validate_bars(bars: dict) -> list:
    problems = []
    for inst, b in bars.items():
        n = len(b["ts"])
        if n == 0:
            problems.append(f"{inst}: empty")
            continue
        if not bool(np.all(np.diff(b["ts"].astype(np.int64)) > 0)):
            problems.append(f"{inst}: non-monotonic ts")
        for k in ("open", "high", "low", "close"):
            arr = np.asarray(b[k], dtype=float)
            if not bool(np.all(np.isfinite(arr))):
                problems.append(f"{inst}: non-finite {k}")
            if bool(np.any(arr <= 0)):
                problems.append(f"{inst}: non-positive {k}")
        vol = np.asarray(b["volume"])
        if bool(np.any(vol < 0)) or not bool(np.all(np.isfinite(vol.astype(float)))):
            problems.append(f"{inst}: bad volume")
    return problems


def build_features_labels(bars: dict, horizon: int, threshold: float,
                          min_rows: int = 50) -> tuple[np.ndarray, np.ndarray, np.ndarray, list]:
    """Causal features + forward labels. Returns (X, y, ts, instruments).

    Feature at row for bar index t uses closes/volumes with index <= t only.
    Label uses close[t+horizon] (future data ONLY in the target definition).
    """
    if horizon < 1:
        raise fail("INVALID_LABEL", "horizon must be >= 1")
    X_parts, y_parts, ts_parts, inst_parts = [], [], [], []
    for inst, b in bars.items():
        close = np.asarray(b["close"], dtype=float)
        volume = np.asarray(b["volume"], dtype=float)
        ts = np.asarray(b["ts"], dtype=np.int64)
        n = len(ts)
        rets = np.empty(n)
        rets[0] = 0.0
        rets[1:] = close[1:] / close[:-1] - 1.0
        rows = []
        for t in range(20, n - horizon):
            # All inputs indexed <= t (causal). Nothing at t+1..t+horizon leaks in.
            f = [
                rets[t], rets[t - 1], rets[t - 2], rets[t - 3], rets[t - 4],
                close[t] / close[t - 10] - 1.0,
                float(np.std(rets[t - 9:t + 1])),
                float(np.mean(volume[t - 4:t + 1]) / max(1.0, float(np.mean(volume[t - 19:t + 1])))),
            ]
            fwd = close[t + horizon] / close[t] - 1.0
            rows.append((f, 1 if fwd > threshold else 0, int(ts[t])))
        if rows:
            X_parts.append(np.array([r[0] for r in rows]))
            y_parts.append(np.array([r[1] for r in rows], dtype=np.int64))
            ts_parts.append(np.array([r[2] for r in rows], dtype=np.int64))
            inst_parts.extend([inst] * len(rows))
    if not X_parts:
        raise fail("INSUFFICIENT_SAMPLES", "no feature rows produced")
    X = np.vstack(X_parts)
    y = np.concatenate(y_parts)
    ts_all = np.concatenate(ts_parts)
    order = np.argsort(ts_all, kind="stable")
    X, y, ts_all = X[order], y[order], ts_all[order]
    inst_all = [inst_parts[i] for i in order]
    if len(y) < min_rows:
        raise fail("INSUFFICIENT_SAMPLES", f"only {len(y)} rows < min {min_rows}")
    if len(np.unique(y)) < 2:
        raise fail("INVALID_LABEL", "single-class labels; adjust threshold/range")
    return X, y, ts_all, inst_all


def chrono_split(n: int, train_frac: float = 0.6, val_frac: float = 0.2):
    """Chronological split indices (no shuffling across time)."""
    if not (0 < train_frac < 1 and 0 < val_frac < 1 and train_frac + val_frac < 1):
        raise fail("INVALID_CONFIG", "bad split fractions")
    n_train = int(n * train_frac)
    n_val = int(n * val_frac)
    train = np.arange(0, n_train)
    val = np.arange(n_train, n_train + n_val)
    test = np.arange(n_train + n_val, n)
    return train, val, test


def dataset_version_id(spec: DatasetSpec) -> str:
    h = hashlib.sha256(json.dumps({
        "id": spec.dataset_id, "instruments": list(spec.instruments),
        "n_bars": spec.n_bars, "seed": spec.seed, "horizon": spec.horizon_bars,
        "threshold": spec.threshold, "start": spec.start_ts,
        "feat": FEATURES_VERSION, "label": LABEL_VERSION,
        "prep": PREPROCESSING_VERSION,
    }, sort_keys=True).encode()).hexdigest()[:12]
    return f"{spec.dataset_id}-{h}"


def write_dataset(root: str, spec: DatasetSpec, X: np.ndarray, y: np.ndarray,
                  ts: np.ndarray, instruments: list, extra: dict | None = None) -> dict:
    """Write immutable versioned dataset. Refuses overwrite on checksum mismatch."""
    version = dataset_version_id(spec)
    ddir = os.path.join(root, version)
    os.makedirs(ddir, exist_ok=True)
    feat_path = os.path.join(ddir, "features.csv")
    header = ",".join([*FEATURE_COLUMNS, "label", "ts", "instrument"])
    lines = [header]
    for i in range(len(y)):
        lines.append(",".join([f"{v:.8f}" for v in X[i]] + [str(int(y[i])), str(int(ts[i])), instruments[i]]))
    payload = ("\n".join(lines) + "\n").encode()
    checksum = hashlib.sha256(payload).hexdigest()
    if os.path.exists(feat_path):
        with open(feat_path, "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() != checksum:
                raise fail("DATASET_CORRUPT", f"existing dataset {version} differs; create a new version")
    else:
        with open(feat_path, "wb") as f:
            f.write(payload)
    n = len(y)
    train, val, test = chrono_split(n)
    manifest = {
        "dataset_id": spec.dataset_id, "dataset_version": version,
        "created_at": int(ts[0]), "source": "aurix-synthetic-ohlcv",
        "feature_spec": {"version": FEATURES_VERSION, "columns": list(FEATURE_COLUMNS),
                         "causal": True, "max_lookback_bars": 20},
        "label_spec": {"version": LABEL_VERSION, "definition": "forward return over horizon > threshold",
                       "horizon_bars": spec.horizon_bars, "threshold": spec.threshold},
        "date_range": [int(ts[0]), int(ts[-1])],
        "instruments": list(spec.instruments),
        "preprocessing_version": PREPROCESSING_VERSION,
        "checksum_sha256": checksum, "n_rows": n,
        "class_balance": {"pos": int(np.sum(y)), "neg": int(n - np.sum(y))},
        "train_range": [int(ts[train[0]]), int(ts[train[-1]])],
        "val_range": [int(ts[val[0]]), int(ts[val[-1]])],
        "test_range": [int(ts[test[0]]), int(ts[test[-1]])],
        "seed": spec.seed,
    }
    if extra:
        protected = {"checksum_sha256", "n_rows", "class_balance", "train_range",
                     "val_range", "test_range", "date_range"}
        for k, v in extra.items():
            if k not in protected:
                manifest[k] = v
    with open(os.path.join(ddir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    return manifest


def load_dataset(ddir: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, list, dict]:
    with open(os.path.join(ddir, "manifest.json")) as f:
        manifest = json.load(f)
    with open(os.path.join(ddir, "features.csv"), "rb") as f:
        raw = f.read()
    if hashlib.sha256(raw).hexdigest() != manifest["checksum_sha256"]:
        raise fail("DATASET_CORRUPT", "checksum mismatch on load")
    rows = raw.decode().strip().split("\n")[1:]
    cols = len(FEATURE_COLUMNS)
    X = np.array([[float(v) for v in r.split(",")[:cols]] for r in rows])
    y = np.array([int(r.split(",")[cols]) for r in rows], dtype=np.int64)
    ts = np.array([int(r.split(",")[cols + 1]) for r in rows], dtype=np.int64)
    inst = [r.split(",")[cols + 2] for r in rows]
    return X, y, ts, inst, manifest
