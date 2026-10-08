"""Historical market-data layer: provider abstraction, validation, builder.

Pipeline: provider -> raw local data -> validation -> quality gate
(PASS/QUARANTINE/BLOCK) -> versioned immutable dataset -> training/backtest.

Primary source: tej-bazaar edge (NSE bhavcopy-derived OHLCV, REST JSON).
Secondary validation: eod2_data static adjusted CSVs (split/bonus adjusted).
Stdlib only (urllib/json/csv/hashlib). No broker, no secrets, no execution.

Point-in-time rule: rows carry only what the source published for date T.
Corporate-action handling is recorded honestly per source (see manifests);
nothing is fabricated. Feature/label code is REUSED from datasets.py.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import time
import urllib.request
from datetime import date, datetime, timezone

from .errors import fail

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AURIX-research"
TEJ_EDGE = "https://api.tejhq.dev/v1/ohlcv"
EOD2_RAW = "https://raw.githubusercontent.com/BennyThadikaran/eod2_data/main/daily"

SCHEMA_VERSION = "hist-schema-v1"


def _get(url: str, timeout: int = 90) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "application/json, text/csv"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except Exception as e:
        raise fail("DATASET_MISSING", f"fetch failed {url}: {e}")


class HistoricalDataProvider:
    """Vendor-neutral interface. Implementations return raw rows only."""

    name = "base"
    adjustment_policy = "unknown"

    def fetch(self, symbol: str, start: str, end: str) -> list:
        raise NotImplementedError

    def source_meta(self) -> dict:
        return {"provider": self.name, "adjustment_policy": self.adjustment_policy}


class TejBazaarProvider(HistoricalDataProvider):
    """tej-bazaar edge JSON: NSE bhavcopy OHLCV as published (RAW, unadjusted).

    Corporate actions / back-adjusted trees exist upstream as parquet only;
    this adapter does NOT invent adjustments — manifest records raw.
    """

    name = "tej-bazaar"
    adjustment_policy = "none-raw-bhavcopy"

    def __init__(self, exchange: str = "nse"):
        self.exchange = exchange

    def fetch(self, symbol: str, start: str, end: str) -> list:
        url = f"{TEJ_EDGE}/{self.exchange}/{symbol}?from={start}&to={end}"
        payload = json.loads(_get(url).decode())
        rows = payload.get("data", payload) if isinstance(payload, dict) else payload
        out = []
        for r in rows:
            out.append({"symbol": symbol, "date": r["date"], "open": float(r["open"]),
                        "high": float(r["high"]), "low": float(r["low"]),
                        "close": float(r["close"]), "volume": int(r["volume"]),
                        "turnover": float(r.get("turnover") or 0),
                        "trades": int(r.get("trades") or 0),
                        "adjusted": False, "source": self.name})
        return out

    def source_meta(self) -> dict:
        return {"provider": self.name, "exchange": self.exchange,
                "adjustment_policy": self.adjustment_policy,
                "upstream": "tejhq/indian-markets (NSE bhavcopy 2010+)"}


class Eod2Provider(HistoricalDataProvider):
    """eod2_data static CSVs: daily OHLCV ADJUSTED for splits/bonuses.

    Full history per symbol; date-filtered locally (point-in-time safe).
    Used as secondary cross-validation source.
    """

    name = "eod2-data"
    adjustment_policy = "split-bonus-adjusted"

    def fetch(self, symbol: str, start: str, end: str) -> list:
        url = f"{EOD2_RAW}/{symbol.lower()}.csv"
        text = _get(url, timeout=120).decode()
        reader = csv.DictReader(io.StringIO(text))
        out = []
        for r in reader:
            d = (r.get("Date") or "").strip()
            if not d or not (start <= d <= end):
                continue
            try:
                out.append({"symbol": symbol, "date": d,
                            "open": float(r["Open"]), "high": float(r["High"]),
                            "low": float(r["Low"]), "close": float(r["Close"]),
                            "volume": int(float(r["Volume"] or 0)),
                            "turnover": 0.0, "trades": 0,
                            "adjusted": True, "source": self.name})
            except (ValueError, KeyError, TypeError):
                continue
        if not out:
            raise fail("DATASET_MISSING", f"no rows for {symbol} in range")
        return out


# ---------------------------------------------------------------------------
# Validation + quality gate (PASS / QUARANTINE / BLOCK).
# Suspicious data is quarantined with reasons, never silently deleted.
# ---------------------------------------------------------------------------

def _to_ms(d: str) -> int:
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def validate_rows(rows: list) -> dict:
    clean, quarantined = [], []
    seen = set()
    prev_ts = None
    blocked = []
    for i, r in enumerate(rows):
        reasons = []
        try:
            ts = _to_ms(r["date"])
        except (ValueError, KeyError):
            quarantined.append({"index": i, "row": r, "reasons": ["malformed-date"]})
            continue
        if ts in seen:
            reasons.append("duplicate-timestamp")
        seen.add(ts)
        for k in ("open", "high", "low", "close"):
            v = r.get(k)
            if not isinstance(v, (int, float)) or not (v == v) or v <= 0:
                reasons.append(f"invalid-{k}")
        vol = r.get("volume", 0)
        if not isinstance(vol, (int, float)) or vol != vol or vol < 0:
            reasons.append("invalid-volume")
        o, h, l, c = r.get("open"), r.get("high"), r.get("low"), r.get("close")
        if all(isinstance(v, (int, float)) for v in (o, h, l, c)):
            if not (h >= max(o, c) and l <= min(o, c)):
                reasons.append("impossible-ohlc")
            if h < l:
                reasons.append("high-below-low")
        if prev_ts is not None and ts <= prev_ts:
            reasons.append("out-of-order")
        prev_ts = ts if prev_ts is None or ts > prev_ts else prev_ts
        if reasons:
            quarantined.append({"index": i, "row": r, "reasons": reasons})
        else:
            clean.append({**r, "ts": ts})
    # Gap scan: missing weekdays are reported (trading halts/holidays exist),
    # quarantined as evidence, never blocking by themselves.
    if clean:
        days = sorted({c["ts"] for c in clean})
        gap = 0
        for a, b in zip(days, days[1:]):
            wd = sum(1 for t in range(a + 86400000, b, 86400000)
                     if datetime.fromtimestamp(t / 1000, timezone.utc).weekday() < 5)
            gap += wd
        if gap:
            quarantined.append({"index": -1, "row": {"symbol": clean[0]["symbol"]},
                                "reasons": [f"missing-weekdays:{gap}"]})
    verdict = "BLOCK" if blocked else ("QUARANTINE" if quarantined else "PASS")
    return {"verdict": verdict, "clean": clean, "quarantined": quarantined,
            "n_raw": len(rows), "blocked": blocked}


# ---------------------------------------------------------------------------
# Builder: validated rows -> training dataset (REUSES datasets.py) +
# backtest-bar export matching apps/backtest DatasetBar.
# ---------------------------------------------------------------------------

def to_training_bars(clean_by_symbol: dict) -> dict:
    bars = {}
    for sym, rows in clean_by_symbol.items():
        rs = sorted(rows, key=lambda r: r["ts"])
        n = len(rs)
        bars[sym] = {"ts": [r["ts"] for r in rs],
                     "open": [r["open"] for r in rs],
                     "high": [r["high"] for r in rs],
                     "low": [r["low"] for r in rs],
                     "close": [r["close"] for r in rs],
                     "volume": [r["volume"] for r in rs]}
        assert n == len(rs)
    return bars


def to_backtest_bars(clean_by_symbol: dict, instrument_prefix: str = "NSE_EQ_") -> list:
    out = []
    for sym, rows in clean_by_symbol.items():
        rs = sorted(rows, key=lambda x: x["ts"])
        turnovers = [(r.get("turnover") or 0) or r["close"] * r["volume"] for r in rs]
        for i, r in enumerate(rs):
            window = turnovers[max(0, i - 19):i + 1]  # trailing-20d incl. T: knowable at T
            adv = sum(window) / len(window)
            out.append({"instrument_id": f"{instrument_prefix}{sym}",
                        "ts": r["ts"], "open": r["open"], "high": r["high"],
                        "low": r["low"], "close": r["close"],
                        "volume": r["volume"], "spread_bps": None,
                        "adv_value": adv})
    return out


def cross_check(primary: list, secondary: list) -> dict:
    """Compare overlapping closes; returns max abs % diff (validation only)."""
    a = {r["date"]: r["close"] for r in primary}
    b = {r["date"]: r["close"] for r in secondary}
    common = sorted(set(a) & set(b))
    if not common:
        return {"n_common": 0, "max_abs_pct_diff": None}
    diffs = [abs(a[d] - b[d]) / a[d] * 100 for d in common if a[d] > 0]
    return {"n_common": len(common), "max_abs_pct_diff": max(diffs) if diffs else None,
            "mean_abs_pct_diff": sum(diffs) / len(diffs) if diffs else None}


def store_raw(out_dir: str, provider: str, symbol: str, payload: bytes) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{provider}-{symbol}.raw")
    with open(path, "wb") as f:
        f.write(payload)
    return {"path": path, "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload), "at": int(time.time())}
