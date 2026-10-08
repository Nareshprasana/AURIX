"""`aurix-train` CLI — exact commands documented in the training proof report.

  aurix-train resources [--policy auto|cpu|cuda]
  aurix-train dataset --out <dir> [--seed 7 --bars 750 --horizon 5 --threshold 0.005]
  aurix-train train --dataset <dir> --out <runs> --run <id> [--epochs 5 --device auto]
  aurix-train resume --run-dir <dir> --epochs <n>
  aurix-train evaluate --run-dir <dir>
  aurix-train laya-probe
  aurix-train laya-decide --state TEXT --question KEY=Q...
  aurix-train registry --db <path> register|promote ...
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def _cmd_resources(args) -> int:
    from .resources import detect_resources, select_device
    rep = select_device(args.policy)
    print(json.dumps(rep.__dict__, indent=2, sort_keys=True))
    return 0


def _cmd_dataset(args) -> int:
    import numpy as np
    from .datasets import (DatasetSpec, build_features_labels, generate_ohlcv,
                           validate_bars, write_dataset)
    instruments = tuple(args.instruments.split(","))
    spec = DatasetSpec(dataset_id="aurix-synth-daily", version="v1",
                       instruments=instruments, n_bars=args.bars, seed=args.seed,
                       horizon_bars=args.horizon, threshold=args.threshold,
                       start_ts=1700000000000)
    bars = generate_ohlcv(spec.seed, spec.n_bars, spec.instruments, spec.start_ts)
    problems = validate_bars(bars)
    if problems:
        print(json.dumps({"status": "REJECTED", "problems": problems}))
        return 1
    X, y, ts, inst = build_features_labels(bars, spec.horizon_bars, spec.threshold)
    manifest = write_dataset(args.out, spec, X, y, ts, inst)
    print(json.dumps({"status": "OK", "manifest": manifest}, indent=2))
    return 0


def _load_policy():
    import yaml
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for cand in (os.path.join(here, "config", "ai-policy.v1.yaml"),
                 os.path.join("config", "ai-policy.v1.yaml")):
        if os.path.exists(cand):
            with open(cand) as f:
                return yaml.safe_load(f)
    return {}


def _cmd_train(args) -> int:
    from .datasets import load_dataset
    from .resources import select_device
    from .train import run_training
    policy = _load_policy()
    ml = (policy.get("market_ml") or {})
    hp = (ml.get("hyperparams") or {})
    X, y, _ts, _inst, manifest = load_dataset(args.dataset)
    rep = select_device(args.device or (policy.get("training") or {}).get("device_policy", "auto"))
    config = {"alpha": hp.get("alpha", 0.0001), "random_state": hp.get("random_state", 7),
              "model_type": ml.get("model_type", "sgd-logloss")}
    out = run_training(args.run, args.out, X, y, manifest["dataset_version"],
                       manifest["feature_spec"]["version"], manifest["label_spec"]["version"],
                       config, rep.device_selected, seed=args.seed, epochs=args.epochs)
    print(json.dumps({"status": "OK", "run_dir": out["run_dir"],
                      "manifest": out["manifest"]}, indent=2))
    print(f"device={rep.device_selected} ({rep.reason})", file=sys.stderr)
    return 0


def _cmd_resume(args) -> int:
    import glob
    from .datasets import load_dataset
    from .model import MarketMLP, load_checkpoint
    from .train import run_training
    with open(os.path.join(args.run_dir, "manifest.json")) as f:
        manifest = json.load(f)
    dataset_dir = args.dataset
    if dataset_dir is None:
        raise SystemExit("resume requires --dataset <dataset-dir>")
    X, y, _ts, _inst, ds_manifest = load_dataset(dataset_dir)
    ckpts = sorted(glob.glob(os.path.join(args.run_dir, "checkpoints", "*.npz")))
    if not ckpts:
        raise SystemExit("no checkpoints to resume from")
    model = MarketMLP()
    meta = load_checkpoint(ckpts[-1], model)
    out = run_training(manifest["run_id"], os.path.dirname(args.run_dir.rstrip("/")),
                       X, y, ds_manifest["dataset_version"],
                       ds_manifest["feature_spec"]["version"],
                       ds_manifest["label_spec"]["version"],
                       meta.get("config", {}), manifest.get("device", "cpu"),
                       seed=meta.get("seed", 7), epochs=args.epochs,
                       start_epoch=model.epoch, model=model)
    print(json.dumps({"status": "OK", "resumed_from": ckpts[-1],
                      "manifest": out["manifest"]}, indent=2))
    return 0


def _cmd_evaluate(args) -> int:
    import joblib
    import numpy as np
    from .datasets import chrono_split, load_dataset
    from .train import evaluate_proba
    with open(os.path.join(args.run_dir, "manifest.json")) as f:
        manifest = json.load(f)
    dataset_dir = args.dataset
    if dataset_dir is None:
        raise SystemExit("evaluate requires --dataset <dataset-dir>")
    X, y, ts, _inst, ds = load_dataset(dataset_dir)
    art = joblib.load(os.path.join(args.run_dir, "final", "artifact.joblib"))
    scale = np.sqrt(np.maximum(art["scaler_var"], 1e-12))
    Xs = (X - art["scaler_mean"]) / scale
    logits = Xs @ art["coef"].T + art["intercept"]
    proba = 1.0 / (1.0 + np.exp(-logits.ravel()))
    _tr, _va, te = chrono_split(len(y))
    oos = evaluate_proba(y[te], proba[te])
    print(json.dumps({"status": "OK", "oos_test": oos,
                      "note": "accuracy is NOT profitability; route through backtest before strategic use"},
                     indent=2))
    return 0


def _cmd_laya_probe(args) -> int:
    from .laya_component import probe_laya
    try:
        print(json.dumps({"status": "OK", "probe": probe_laya()}, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"status": "FAILED", "error": str(e)}))
        return 1


def _cmd_laya_decide(args) -> int:
    from .laya_component import run_decision
    import json as _json
    questions = {}
    if args.qjson:
        questions = _json.loads(args.qjson)
    for item in args.question or []:
        k, _, q = item.partition("=")
        questions[k] = {"question": q or k}
    try:
        sig = run_decision(args.state, questions, device=args.device)
        payload = {"status": "OK", "signal": sig.__dict__}
        print(json.dumps(payload, indent=2, default=str))
        if args.out:
            with open(args.out, "w") as f:
                json.dump(payload, f, indent=2, default=str)
        return 0
    except Exception as e:
        print(json.dumps({"status": "FAILED", "error": str(e)}))
        return 1


def _cmd_registry(args) -> int:
    from .registry import ModelRegistry
    reg = ModelRegistry(args.db)
    if args.action == "register":
        print(json.dumps(reg.register(args.model_id, args.run_id, args.sha, args.operator), indent=2))
    elif args.action == "promote":
        print(json.dumps(reg.promote(args.model_id, args.to, args.operator, args.reason), indent=2))
    elif args.action == "active":
        print(json.dumps(reg.active(), indent=2))
    return 0


def _cmd_history_fetch(args) -> int:
    from .history import Eod2Provider, TejBazaarProvider, _get
    providers = {"tej": TejBazaarProvider(), "eod2": Eod2Provider()}
    if args.provider != "both":
        providers = {args.provider: providers[args.provider]}
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    summary = {"provider_set": list(providers), "symbols": {}, "raw_dir": args.out}
    for pname, prov in providers.items():
        for sym in symbols:
            if pname == "tej":
                url = (f"https://api.tejhq.dev/v1/ohlcv/nse/{sym}"
                       f"?from={args.from_date}&to={args.to_date}")
                payload = _get(url)
            else:
                url = f"https://raw.githubusercontent.com/BennyThadikaran/eod2_data/main/daily/{sym.lower()}.csv"
                payload = _get(url, timeout=120)
            from .history import store_raw
            import os as _os
            rec = store_raw(_os.path.join(args.out, "raw"), pname, sym, payload)
            # Parse immediately to count rows (cheap, proves parse works).
            rows = prov.fetch(sym, args.from_date, args.to_date) if pname == "tej" else prov.fetch(sym, args.from_date, args.to_date)
            summary["symbols"].setdefault(sym, {})[pname] = {"rows": len(rows), **rec}
    print(json.dumps({"status": "OK", "fetch": summary}, indent=2))
    return 0


def _cmd_history_build(args) -> int:
    import os as _os
    from .datasets import (DatasetSpec, build_features_labels, write_dataset)
    from .history import (Eod2Provider, TejBazaarProvider, cross_check,
                          to_backtest_bars, to_training_bars, validate_rows)
    prov = TejBazaarProvider() if args.provider == "tej" else Eod2Provider()
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    clean_by_symbol, quality = {}, {}
    for sym in symbols:
        rows = prov.fetch(sym, args.from_date, args.to_date)
        rep = validate_rows(rows)
        quality[sym] = {"verdict": rep["verdict"], "n_raw": rep["n_raw"],
                        "n_clean": len(rep["clean"]),
                        "n_quarantined": len(rep["quarantined"]),
                        "quarantine_reasons": sorted({r for q in rep["quarantined"] for r in q["reasons"]})}
        if rep["verdict"] == "BLOCK" or not rep["clean"]:
            raise SystemExit(f"quality BLOCK/empty for {sym}: {quality[sym]}")
        clean_by_symbol[sym] = rep["clean"]
    check = None
    if args.cross_check:
        sec = Eod2Provider() if args.provider == "tej" else TejBazaarProvider()
        diffs = {}
        for sym in symbols:
            try:
                other = sec.fetch(sym, args.from_date, args.to_date)
                diffs[sym] = cross_check(clean_by_symbol[sym], other)
            except Exception as e:
                diffs[sym] = {"error": str(e)}
        check = diffs
    bars = to_training_bars(clean_by_symbol)
    X, y, ts, inst = build_features_labels(bars, args.horizon, args.threshold)
    spec = DatasetSpec(dataset_id=args.id, version="v1", instruments=tuple(symbols),
                       n_bars=sum(len(v) for v in clean_by_symbol.values()),
                       seed=7, horizon_bars=args.horizon, threshold=args.threshold,
                       start_ts=int(min(ts)))
    manifest = write_dataset(args.out + "/datasets", spec, X, y, ts, inst, extra={
        "source": prov.name, "source_ref": "tejhq/indian-markets + api.tejhq.dev" if args.provider == "tej" else "BennyThadikaran/eod2_data@main",
        "schema_version": "hist-schema-v1",
        "adjustment_policy": prov.adjustment_policy,
        "quality": quality, "cross_check": check,
        "date_range_requested": [args.from_date, args.to_date],
    })
    bt = to_backtest_bars(clean_by_symbol)
    bdir = _os.path.join(args.out, "processed", manifest["dataset_version"])
    _os.makedirs(bdir, exist_ok=True)
    with open(_os.path.join(bdir, "backtest-bars.json"), "w") as f:
        json.dump(bt, f)
    with open(_os.path.join(bdir, "quality.json"), "w") as f:
        json.dump(quality, f, indent=2)
    print(json.dumps({"status": "OK", "manifest": manifest,
                      "n_backtest_bars": len(bt)}, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="aurix-train")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("resources"); s.add_argument("--policy", default="auto"); s.set_defaults(fn=_cmd_resources)
    s = sub.add_parser("dataset"); s.add_argument("--out", required=True)
    s.add_argument("--seed", type=int, default=7); s.add_argument("--bars", type=int, default=750)
    s.add_argument("--horizon", type=int, default=5); s.add_argument("--threshold", type=float, default=0.005)
    s.add_argument("--instruments", default="NSE_EQ_RELIANCE,NSE_EQ_INFY"); s.set_defaults(fn=_cmd_dataset)
    s = sub.add_parser("train"); s.add_argument("--dataset", required=True); s.add_argument("--out", required=True)
    s.add_argument("--run", required=True); s.add_argument("--epochs", type=int, default=5)
    s.add_argument("--seed", type=int, default=7); s.add_argument("--device", default=None); s.set_defaults(fn=_cmd_train)
    s = sub.add_parser("resume"); s.add_argument("--run-dir", required=True); s.add_argument("--dataset", default=None)
    s.add_argument("--epochs", type=int, required=True); s.set_defaults(fn=_cmd_resume)
    s = sub.add_parser("evaluate"); s.add_argument("--run-dir", required=True); s.add_argument("--dataset", default=None); s.set_defaults(fn=_cmd_evaluate)
    s = sub.add_parser("laya-probe"); s.set_defaults(fn=_cmd_laya_probe)
    s = sub.add_parser("laya-decide"); s.add_argument("--state", required=True); s.add_argument("--question", action="append", default=[])
    s.add_argument("--qjson", default=None); s.add_argument("--out", default=None)
    s.add_argument("--device", default="cpu"); s.set_defaults(fn=_cmd_laya_decide)
    s = sub.add_parser("registry"); s.add_argument("--db", required=True); s.add_argument("--action", choices=["register", "promote", "active"], required=True)
    s.add_argument("--model-id", default=None); s.add_argument("--run-id", default=None); s.add_argument("--sha", default=None)
    s.add_argument("--to", default=None); s.add_argument("--operator", default="operator"); s.add_argument("--reason", default=""); s.set_defaults(fn=_cmd_registry)
    s = sub.add_parser("history-fetch"); s.add_argument("--symbols", required=True); s.add_argument("--from-date", required=True)
    s.add_argument("--to-date", required=True); s.add_argument("--provider", default="tej", choices=["tej", "eod2", "both"])
    s.add_argument("--out", required=True); s.set_defaults(fn=_cmd_history_fetch)
    s = sub.add_parser("history-build"); s.add_argument("--symbols", required=True); s.add_argument("--from-date", required=True)
    s.add_argument("--to-date", required=True); s.add_argument("--provider", default="tej", choices=["tej", "eod2"])
    s.add_argument("--out", required=True); s.add_argument("--id", default="aurix-nse-daily")
    s.add_argument("--horizon", type=int, default=5); s.add_argument("--threshold", type=float, default=0.005)
    s.add_argument("--cross-check", action="store_true"); s.set_defaults(fn=_cmd_history_build)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
