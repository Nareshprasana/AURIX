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


def _cmd_auto_submit(args) -> int:
    from .orchestrate import ExperimentRegistry, emit_event, runs_root
    root = runs_root(args.runs)
    reg = ExperimentRegistry(root)
    with open(args.def_json) as f:
        defn = json.load(f)
    rec = reg.submit(defn)
    emit_event(os.path.join(root, rec["experiment_id"]), rec["experiment_id"],
               "EXPERIMENT_QUEUED", {"dataset_dir": defn["dataset_dir"]})
    print(json.dumps({"status": "OK", "experiment": rec}, indent=2))
    return 0


def _cmd_auto_suggest(args) -> int:
    import yaml
    from .orchestrate import ExperimentRegistry, experiment_id, runs_root
    policy = {}
    for cand in ("config/ai-policy.v1.yaml", "../config/ai-policy.v1.yaml"):
        if os.path.exists(cand):
            with open(cand) as f:
                policy = yaml.safe_load(f) or {}
            break
    auto = policy.get("automation", {})
    budget = int(args.budget or auto.get("max_experiments_per_cycle", 3))
    base = json.load(open(args.base_json)) if args.base_json else {}
    seeds = [7, 11, 13, 17, 23][:budget]
    reg = ExperimentRegistry(runs_root(args.runs))
    out = []
    for seed in seeds:
        d = dict(base)
        d.setdefault("model_type", "sgd-logloss")
        d.setdefault("hyperparameters", {"alpha": 0.0001, "random_state": seed})
        d["seed"] = seed
        d.setdefault("epochs", int(auto.get("default_epochs", 5)))
        d.setdefault("device", "cpu")
        eid = experiment_id(d)
        if eid not in reg.exps:
            d["_experiment_id"] = eid
            out.append(d)
    if args.llm_json:
        proposal = json.load(open(args.llm_json))
        from .orchestrate import validate_definition
        validate_definition(proposal)  # structured + validated before execution
        proposal["_experiment_id"] = experiment_id(proposal)
        proposal["_source"] = "llm-proposal"
        out.append(proposal)
    print(json.dumps({"status": "OK", "suggestions": out}, indent=2))
    return 0


def _node_backtest_runner(bars_path: str, exp_dir: str) -> dict:
    import subprocess as _sp
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    script = os.path.join(repo, "scripts", "backtest-gate.mjs")
    hooks = os.path.join(repo, "scripts", "aurix-register.mjs")
    try:
        r = _sp.run(["node", "--import", hooks, script, bars_path],
                    capture_output=True, text=True, timeout=300, cwd=repo)
        last = [l for l in r.stdout.strip().split("\n") if l.strip()][-1]
        return json.loads(last)
    except Exception as e:
        return {"ok": False, "reason": f"backtest runner failed: {e}"}


def _load_gates() -> tuple:
    import yaml
    policy, auto, gates = {}, {}, {}
    for cand in ("config/ai-policy.v1.yaml", "../config/ai-policy.v1.yaml"):
        if os.path.exists(cand):
            with open(cand) as f:
                policy = yaml.safe_load(f) or {}
            break
    auto = policy.get("automation", {})
    sched = {"max_concurrent_training": int(auto.get("max_concurrent_training", 1)),
             "heartbeat_timeout_s": int(auto.get("heartbeat_timeout_s", 600))}
    gates = {"min_oos_edge_vs_baseline": float(auto.get("min_oos_edge_vs_baseline", 0.01)),
             "max_backtest_drawdown_pct": float(auto.get("max_backtest_drawdown_pct", 10.0))}
    return sched, gates


def _cmd_auto_cycle(args) -> int:
    from .orchestrate import Scheduler, runs_root
    sched, gates = _load_gates()
    s = Scheduler(runs_root(args.runs), sched, backtest_runner=_node_backtest_runner)
    print(json.dumps({"status": "OK", "cycle": s.cycle(detach=args.detach)}, indent=2, default=str))
    return 0


def _cmd_auto_status(args) -> int:
    from .orchestrate import ExperimentRegistry, read_heartbeat, runs_root
    root = runs_root(args.runs)
    reg = ExperimentRegistry(root)
    rows = []
    for eid, exp in sorted(reg.exps.items()):
        hb = read_heartbeat(os.path.join(root, eid))
        gov_path = os.path.join(root, eid, "governance.json")
        last_result = None
        if os.path.exists(gov_path):
            last_result = json.load(open(gov_path)).get("outcome")
        elif os.path.exists(os.path.join(root, eid, "eval.json")):
            ev = json.load(open(os.path.join(root, eid, "eval.json")))
            last_result = f"acc={ev['accuracy']:.4f} base={ev['baseline_majority_accuracy']:.4f}"
        stage = {"QUEUED": "awaiting worker", "RUNNING": "training",
                 "COMPLETED": "awaiting evaluation", "EVALUATED": "awaiting governance"}.get(
            exp["status"], exp["status"].lower())
        rows.append({"experiment": eid, "state": exp["status"],
                     "elapsed_ms": (exp.get("completed_at") or int(__import__('time').time() * 1000))
                     - (exp.get("started_at") or exp["created_at"]),
                     "epoch": (hb or {}).get("epoch"),
                     "checkpoint": (hb or {}).get("checkpoint"),
                     "worker_pid": (hb or {}).get("pid"),
                     "next": stage, "last_result": last_result})
    print(json.dumps({"status": "OK", "runs_root": root, "experiments": rows}, indent=2))
    return 0


def _spawn_supervisor(root: str, interval: int) -> int:
    import subprocess as _sp
    svc = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(root, exist_ok=True)
    log = open(os.path.join(root, "supervisor.log"), "ab")
    flags = 0
    if os.name == "nt":
        flags = 0x00000008 | 0x00000200
    p = _sp.Popen([sys.executable, "-m", "aurix_ai.cli", "auto-supervise",
                   "--runs", root, "--interval", str(interval)],
                  cwd=os.path.join(svc, ".."), stdout=log, stderr=_sp.STDOUT,
                  stdin=_sp.DEVNULL, start_new_session=(os.name != "nt"),
                  creationflags=flags)
    with open(os.path.join(root, "supervisor.pid"), "w") as f:
        f.write(str(p.pid))
    return p.pid


def _cmd_auto_start(args) -> int:
    from .orchestrate import runs_root
    svc = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(args.runs or os.path.join(svc, "..", "..", "data", "runs"))
    pid = _spawn_supervisor(root, args.interval)
    print(json.dumps({"status": "OK", "supervisor_pid": pid, "runs_root": root,
                      "note": "detached local supervisor (not a Windows service)"}))
    return 0


def _discover_default_dataset(datasets_root: str | None) -> tuple:
    """Pick the newest valid versioned dataset. Fail closed when none exists."""
    import yaml
    from .datasets import load_dataset
    from .orchestrate import repo_root
    policy = {}
    for cand in ("config/ai-policy.v1.yaml", "../config/ai-policy.v1.yaml"):
        if os.path.exists(cand):
            with open(cand) as f:
                policy = yaml.safe_load(f) or {}
            break
    droots = [datasets_root] if datasets_root else []
    droots.append((policy.get("automation", {}) or {}).get("default_dataset_dir"))
    droots.append(os.path.join(repo_root(), "data", "datasets"))
    candidates = []
    for droot in droots:
        if not droot or not os.path.isdir(droot):
            continue
        for name in sorted(os.listdir(droot)):
            ddir = os.path.join(droot, name)
            if os.path.isdir(ddir) and os.path.exists(os.path.join(ddir, "manifest.json")):
                candidates.append(ddir)
        if candidates:
            break
    last_error = "no versioned dataset found"
    for ddir in sorted(candidates):
        try:
            _X, _y, _ts, _inst, manifest = load_dataset(ddir)
            return ddir, manifest
        except Exception as e:
            last_error = f"{ddir}: {e}"
    from .errors import fail
    raise fail("DATASET_MISSING", last_error)


def _cmd_auto_train(args) -> int:
    """Single user-facing entry (`aurix train`). Takes no dataset/run/epoch
    args: ensures default experiments exist, then hands off to a detached
    supervisor and returns immediately. Workers continue independently."""
    import yaml
    from .orchestrate import ExperimentRegistry, Scheduler, runs_root
    policy = {}
    for cand in ("config/ai-policy.v1.yaml", "../config/ai-policy.v1.yaml"):
        if os.path.exists(cand):
            with open(cand) as f:
                policy = yaml.safe_load(f) or {}
            break
    auto = policy.get("automation", {})
    ml = policy.get("market_ml", {})
    root = runs_root(args.runs)
    reg = ExperimentRegistry(root)
    active = [e for e in reg.exps.values() if e["status"] in ("QUEUED", "RUNNING")]
    submitted = []
    if not active:
        ddir, manifest = _discover_default_dataset(args.datasets)
        budget = int(auto.get("max_experiments_per_cycle", 3))
        epochs = int(auto.get("default_epochs", 5))
        hp = dict((ml.get("hyperparameters") or {}))
        backtest_bars = None
        from .orchestrate import repo_root
        cand_bars = os.path.join(repo_root(), "data", "processed",
                                 manifest["dataset_version"], "backtest-bars.json")
        if os.path.exists(cand_bars):
            backtest_bars = cand_bars
        for seed in [7, 11, 13, 17, 23][:budget]:
            hp_seed = dict(hp)
            hp_seed["random_state"] = seed
            d = {"dataset_dir": ddir, "dataset_version": manifest["dataset_version"],
                 "model_type": ml.get("model_type", "sgd-logloss"),
                 "hyperparameters": hp_seed, "seed": seed, "epochs": epochs,
                 "device": "cpu"}
            if backtest_bars:
                d["backtest_bars"] = backtest_bars
            try:
                rec = reg.submit(d)
                submitted.append(rec["experiment_id"])
            except Exception:
                pass  # existing ID: immutable history, never resubmitted
    if args.once:
        sched, gates = _load_gates()
        s = Scheduler(root, sched, backtest_runner=_node_backtest_runner)
        cycle = s.cycle(detach=True)
        print(json.dumps({"status": "OK", "mode": "once", "runs_root": root,
                          "submitted": submitted, "cycle": cycle,
                          "next": "workers continue independently; use auto-status"},
                         indent=2, default=str))
        return 0
    pid = _spawn_supervisor(os.path.abspath(root), args.interval)
    print(json.dumps({"status": "OK", "mode": "supervised", "runs_root": root,
                      "submitted": submitted, "supervisor_pid": pid,
                      "message": "automated training started; workers continue independently"},
                     indent=2))
    return 0


def _cmd_auto_supervise(args) -> int:
    import time as _time
    from .orchestrate import Scheduler, runs_root
    sched, gates = _load_gates()
    s = Scheduler(runs_root(args.runs), sched, backtest_runner=_node_backtest_runner)
    while True:
        try:
            s.cycle(detach=True)
        except Exception as e:
            with open(os.path.join(s.root, "supervisor-errors.log"), "a") as f:
                f.write(json.dumps({"at": int(_time.time() * 1000), "error": str(e)}) + "\n")
        _time.sleep(max(10, int(args.interval)))


def _cmd_auto_worker(args) -> int:
    from .worker import run_worker
    raise SystemExit(run_worker(args.exp_dir, resume=args.resume))


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
    s = sub.add_parser("auto-submit"); s.add_argument("--def-json", required=True, dest="def_json"); s.add_argument("--runs", default=None); s.set_defaults(fn=_cmd_auto_submit)
    s = sub.add_parser("auto-suggest"); s.add_argument("--base-json", default=None); s.add_argument("--budget", type=int, default=None); s.add_argument("--llm-json", default=None); s.add_argument("--runs", default=None); s.set_defaults(fn=_cmd_auto_suggest)
    s = sub.add_parser("auto-cycle"); s.add_argument("--runs", default=None); s.add_argument("--detach", action="store_true"); s.set_defaults(fn=_cmd_auto_cycle)
    s = sub.add_parser("auto-status"); s.add_argument("--runs", default=None); s.set_defaults(fn=_cmd_auto_status)
    s = sub.add_parser("auto-start"); s.add_argument("--runs", default=None); s.add_argument("--interval", type=int, default=30); s.set_defaults(fn=_cmd_auto_start)
    s = sub.add_parser("auto-supervise"); s.add_argument("--runs", default=None); s.add_argument("--interval", type=int, default=30); s.set_defaults(fn=_cmd_auto_supervise)
    s = sub.add_parser("auto-worker"); s.add_argument("--exp-dir", required=True); s.add_argument("--resume", action="store_true"); s.set_defaults(fn=_cmd_auto_worker)
    s = sub.add_parser("auto-train"); s.add_argument("--runs", default=None); s.add_argument("--datasets", default=None); s.add_argument("--interval", type=int, default=30); s.add_argument("--once", action="store_true"); s.set_defaults(fn=_cmd_auto_train)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
