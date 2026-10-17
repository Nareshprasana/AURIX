"""Autonomous research agent: outcome-driven experiment planning (deterministic).

Closed loop over EXISTING infrastructure only:
  read outcomes (registry + run dirs) -> derive questions -> hypothesize ->
  validate proposal -> submit via ExperimentRegistry -> supervisor executes ->
  classify result -> persist conclusion -> next cycle reads it.

- No training, no promotion, no broker, no LLM requirement. An optional
  --llm-json proposal is schema-validated like any other input; malformed or
  unavailable LLM output fails safe to the deterministic path.
- Durable state = registry + run dirs + append-only research.jsonl (same
  OBSERVATION record shape as knowledge_refs). Re-reading derives everything;
  restarts cannot duplicate (deterministic content-hash IDs) or erase.
- Bounds: per-cycle cap, total budget cap, failure budget, fingerprint dedupe
  (including previously REJECTED), single worker enforced downstream.
"""

from __future__ import annotations

import hashlib
import json
import os
import time

from .errors import fail

RESEARCH_VERSION = "research-v1"
SUPPORTED_MODELS = ("sgd-logloss", "logreg-lbfgs", "torch-mlp")
SUPPORTED_FEATURES = ("feat-v1", "feat-v2")
SUPPORTED_LABELS = ("label-v1",)
SUPPORTED_HP_KEYS = frozenset({"alpha", "learning_rate", "eta0", "random_state",
                                "hidden_dims", "lr", "weight_decay", "batch_size", "activation"})
OUTCOME_CLASSES = ("VALID_IMPROVEMENT", "VALID_NEGATIVE", "INCONCLUSIVE",
                   "DATA_FAILURE", "MODEL_FAILURE", "EVAL_FAILURE",
                   "INFRA_FAILURE", "GOVERNANCE_REJECTED")
DEFAULT_TOTAL_BUDGET = 12
DEFAULT_PER_CYCLE = 3


def _now() -> int:
    return int(time.time() * 1000)


def _hid(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:12]


def research_log_path(runs_root: str) -> str:
    return os.path.join(runs_root, "research.jsonl")


def read_research_log(runs_root: str) -> list:
    path = research_log_path(runs_root)
    if not os.path.exists(path):
        return []
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def _append_record(runs_root: str, record: dict) -> dict:
    record = {"assertion": "OBSERVATION", "kind": "research",
              "created_at": _now(), **record}
    with open(research_log_path(runs_root), "a") as f:
        f.write(json.dumps(record, sort_keys=True) + "\n")
    return record


def read_outcomes(runs_root: str) -> list:
    """Eligible prior outcomes: terminal or evaluated experiments with
    readable run artifacts. RUNNING/QUEUED work is never an outcome."""
    from .orchestrate import ExperimentRegistry
    reg = ExperimentRegistry(runs_root)
    outcomes = []
    for eid, exp in sorted(reg.exps.items()):
        status = exp.get("status")
        if status in ("QUEUED", "RUNNING"):
            continue
        edir = os.path.join(runs_root, eid)
        manifest = _read_json(os.path.join(edir, "manifest.json"))
        ev = _read_json(os.path.join(edir, "eval.json"))
        gov = _read_json(os.path.join(edir, "governance.json"))
        bt = _read_json(os.path.join(edir, "backtest.json"))
        outcomes.append({"experiment_id": eid, "status": status,
                         "definition": exp.get("definition", {}),
                         "manifest": manifest, "eval": ev,
                         "governance": gov, "backtest": bt,
                         "completed_at": exp.get("completed_at")})
    return outcomes


def _read_json(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _manifest_feat_ver(ddir: str | None) -> str:
    if not ddir or not os.path.isdir(ddir):
        return "feat-v1"
    man = _read_json(os.path.join(ddir, "manifest.json"))
    if man and isinstance(man, dict):
        return man.get("feature_spec", {}).get("version", "feat-v1")
    return "feat-v1"



def classify_outcome(outcome: dict, best_edge: float | None) -> dict:
    """Classify into the 8 outcome classes. Infra problems are NEVER model
    verdicts; poor valid numbers are NEVER infra errors."""
    status = outcome.get("status")
    ev, gov, bt = outcome.get("eval"), outcome.get("governance"), outcome.get("backtest")
    manifest = outcome.get("manifest")
    if status == "VALIDATED":
        return {"class": "VALID_IMPROVEMENT",
                "reason": "passed governance; sets the bar for future comparisons",
                "edge": (gov or {}).get("edge")}
    if status == "FAILED":
        return {"class": "INFRA_FAILURE",
                "reason": "worker/eval/backtest infrastructure failed; not a model verdict"}
    if manifest is None:
        return {"class": "DATA_FAILURE",
                "reason": "no training manifest: dataset unreadable or training never produced output"}
    if ev is None:
        return {"class": "EVAL_FAILURE",
                "reason": "training completed but evaluation missing/failed"}
    if status == "REJECTED" or (gov and gov.get("outcome") == "REJECTED"):
        return {"class": "GOVERNANCE_REJECTED",
                "reason": f"edge={gov.get('edge') if gov else '?'} backtest_ok={gov.get('backtest_ok') if gov else '?'}",
                "edge": (gov or {}).get("edge")}
    acc, base = ev.get("accuracy"), ev.get("baseline_majority_accuracy")
    n = ev.get("n", 0) or 0
    if acc is None or base is None:
        return {"class": "EVAL_FAILURE", "reason": "evaluation metrics incomplete"}
    edge = acc - base
    if n < 30:
        return {"class": "INCONCLUSIVE",
                "reason": f"n={n} too small to distinguish from noise", "edge": edge}
    if best_edge is not None and edge > best_edge + 1e-9:
        return {"class": "VALID_IMPROVEMENT",
                "reason": f"edge {edge:.4f} beats best {best_edge:.4f} (still subject to governance)",
                "edge": edge}
    if edge <= 0:
        return {"class": "VALID_NEGATIVE",
                "reason": f"edge {edge:.4f} <= 0: valid evidence against this configuration",
                "edge": edge}
    if abs(edge) < 0.005:
        return {"class": "INCONCLUSIVE",
                "reason": f"edge {edge:.4f} within noise band", "edge": edge}
    return {"class": "VALID_NEGATIVE",
            "reason": f"edge {edge:.4f} positive but below improvement bar", "edge": edge}


def best_edge_from(log: list) -> float | None:
    edges = [r.get("edge") for r in log
             if r.get("record") == "conclusion" and isinstance(r.get("edge"), (int, float))]
    return max(edges) if edges else None


def known_fingerprints(runs_root: str) -> set:
    """Fingerprints already tried (registry) or concluded (research log).
    Dry-run hypotheses are plans, not work: they never block execution."""
    from .orchestrate import ExperimentRegistry, experiment_id
    fps = set()
    reg = ExperimentRegistry(runs_root)
    for exp in reg.exps.values():
        try:
            fps.add(experiment_id(exp.get("definition", {})))
        except Exception:
            pass
    for r in read_research_log(runs_root):
        if r.get("record") == "conclusion" and r.get("fingerprint"):
            fps.add(r["fingerprint"])
    return fps


def rejected_fingerprints(runs_root: str) -> set:
    return {r["fingerprint"] for r in read_research_log(runs_root)
            if r.get("record") == "conclusion"
            and r.get("outcome_class") == "GOVERNANCE_REJECTED" and r.get("fingerprint")}


def derive_questions(outcomes: list, log: list, datasets: list) -> list:
    """Deterministic question rules over outcomes. No LLM required."""
    questions = []
    seen_texts = {r.get("question") for r in log if r.get("record") == "question"}

    def ask(text: str, based_on: list, topic: str):
        qid = f"rq-{_hid(topic, text)}"
        if text in seen_texts or any(r.get("id") == qid for r in log if r.get("record") == "question"):
            return None
        return {"id": qid, "question": text, "topic": topic, "based_on": sorted(based_on)}

    if not outcomes:
        # No evidence yet: always (re)propose the baseline. Submission dedupe
        # via fingerprint prevents duplicate work; dry runs never block.
        ds = datasets[0] if datasets else "unknown-dataset"
        text = f"Establish a baseline: does sgd-logloss beat majority on {ds}?"
        return [{"id": f"rq-{_hid('baseline', text)}", "question": text,
                 "topic": "baseline", "based_on": []}] if datasets else []
    rej = [o for o in outcomes if o.get("_class") == "GOVERNANCE_REJECTED"]
    infra = [o for o in outcomes if o.get("_class") == "INFRA_FAILURE"]
    unconv = [o for o in outcomes if o.get("_class") in ("VALID_NEGATIVE", "INCONCLUSIVE")]
    for o in rej:
        ds = (o.get("definition") or {}).get("dataset_version", "")
        if "adjusted" not in ds:
            alt = [d for d in datasets if "adjusted" in d]
            if alt:
                q = ask(f"Does split/bonus-adjusted data change the edge vs {ds} (rejected {o['experiment_id']})?",
                        [o["experiment_id"]], "adjustment")
                if q:
                    questions.append(q)
        exp_feat = (o.get("manifest") or {}).get("feature_version") or "feat-v1"
        if exp_feat == "feat-v1":
            feat2_ds = [d for d in datasets if "feat-v2" in d or _manifest_feat_ver(d) == "feat-v2"]
            if feat2_ds:
                q = ask(f"Does feat-v2 feature engineering provide stronger signal than {exp_feat} on {o['experiment_id']}?",
                        [o["experiment_id"]], "features")
                if q:
                    questions.append(q)
    for o in infra:
        q = ask(f"Is the failure of {o['experiment_id']} systematic or transient?",
                [o["experiment_id"]], "reliability")
        if q:
            questions.append(q)
    if unconv:
        ids = sorted(o["experiment_id"] for o in unconv)
        q = ask(f"Do extended training budgets change the edge for {len(ids)} non-improving run(s)?",
                ids, "budget")
        if q:
            questions.append(q)
    if not questions:
        ids = sorted(o["experiment_id"] for o in outcomes)
        q = ask("Do alternative seeds/hyperparameters within the supported grid change the edge?",
                ids, "exploration")
        if q:
            questions.append(q)
    return questions


def propose_experiment(question: dict, datasets: list, base_hp: dict,
                       seed: int, epochs: int, budget_note: str = "",
                       model_type: str = "sgd-logloss") -> dict:
    """Build a candidate definition from a question. Supported space only."""
    if model_type not in SUPPORTED_MODELS:
        raise fail("INVALID_CONFIG", f"unsupported model: {model_type}")
    ds = datasets[0] if datasets else None
    if question.get("topic") == "adjustment":
        adj = [d for d in datasets if "adjusted" in d]
        ds = adj[0] if adj else ds
    elif question.get("topic") == "features":
        feat2 = [d for d in datasets if "feat-v2" in d or _manifest_feat_ver(d) == "feat-v2"]
        ds = feat2[0] if feat2 else ds
    if not ds:
        raise fail("DATASET_MISSING", "no dataset available for proposal")
    hp = dict(base_hp or {})
    hp["random_state"] = seed
    return {"dataset_dir": ds, "model_type": model_type,
            "hyperparameters": hp, "seed": seed, "epochs": epochs,
            "device": "cpu", "_question_id": question["id"],
            "_budget_note": budget_note}


def validate_proposal(defn: dict, runs_root: str, datasets: list) -> dict:
    """Schema + policy + duplicate + exhaustion checks. Rejects fabrications."""
    from .orchestrate import experiment_id
    clean = {k: defn.get(k) for k in
             ("dataset_dir", "dataset_version", "model_type", "hyperparameters",
              "seed", "epochs", "device", "backtest_bars")}
    clean = {k: v for k, v in clean.items() if v is not None}
    if clean.get("model_type", "sgd-logloss") not in SUPPORTED_MODELS:
        raise fail("INVALID_CONFIG", f"unsupported model: {clean.get('model_type')}")
    hp = clean.get("hyperparameters", {}) or {}
    unknown = set(hp) - SUPPORTED_HP_KEYS
    if unknown:
        raise fail("INVALID_CONFIG", f"unsupported hyperparameters: {sorted(unknown)}")
    ddir = clean.get("dataset_dir")
    if not ddir or not os.path.isdir(ddir):
        raise fail("DATASET_MISSING", f"dataset dir absent: {ddir}")
    if os.path.abspath(ddir) not in [os.path.abspath(d) for d in datasets]:
        raise fail("DATASET_MISSING", f"dataset not in approved roots: {ddir}")
    try:
        from .datasets import load_dataset
        _X, _y, _ts, _inst, manifest = load_dataset(ddir)
    except Exception as e:
        raise fail("DATASET_MISSING", f"dataset unloadable: {e}")
    if manifest.get("feature_spec", {}).get("version") not in SUPPORTED_FEATURES:
        raise fail("INVALID_CONFIG", "unsupported feature version")
    if manifest.get("label_spec", {}).get("version") not in SUPPORTED_LABELS:
        raise fail("INVALID_CONFIG", "unsupported label version")
    clean["dataset_version"] = manifest.get("dataset_version")
    clean["feature_version"] = manifest.get("feature_spec", {}).get("version", "feat-v1")
    clean["epochs"] = int(clean.get("epochs", 5))
    if clean["epochs"] < 1:
        raise fail("INVALID_CONFIG", "epochs must be >= 1")
    fp = experiment_id({**clean, "seed": clean.get("seed", 7)})
    if fp in known_fingerprints(runs_root):
        raise fail("INVALID_CONFIG", f"duplicate experiment (fingerprint {fp})")
    if fp in rejected_fingerprints(runs_root):
        raise fail("INVALID_CONFIG", f"fingerprint {fp} was already REJECTED")
    clean["_fingerprint"] = fp
    return clean


def record_question(runs_root: str, question: dict) -> dict:
    return _append_record(runs_root, {"record": "question", "id": question["id"],
                                      **{k: v for k, v in question.items() if k != "id"}})


def record_hypothesis(runs_root: str, hypothesis: dict) -> dict:
    return _append_record(runs_root, {"record": "hypothesis", **hypothesis})


def record_conclusion(runs_root: str, conclusion: dict) -> dict:
    return _append_record(runs_root, {"record": "conclusion", **conclusion})


def make_hypothesis(question: dict, definition: dict, fingerprint: str,
                    baseline: float | None, expectation: str) -> dict:
    return {"id": f"hyp-{_hid(question['id'], fingerprint)}", "version": "hyp-v1",
            "question_id": question["id"], "question": question["question"],
            "hypothesis": expectation,
            "expected_outcome": "edge > baseline majority accuracy",
            "falsification": "edge <= baseline majority accuracy rejects this hypothesis",
            "supporting_evidence": question.get("based_on", []),
            "contradicting_evidence": [],
            "dataset_version": definition.get("dataset_version"),
            "feature_version": definition.get("feature_version") or _manifest_feat_ver(definition.get("dataset_dir")),
            "label_version": SUPPORTED_LABELS[0],
            "methodology": "chronological train/val/test; train-only scaler; OOS eval",
            "model": definition.get("model_type"),
            "hyperparameters": definition.get("hyperparameters"),
            "baseline": baseline, "budget": definition.get("epochs"),
            "fingerprint": fingerprint, "status": "PROPOSED"}


def run_cycle(runs_root: str, datasets: list, policy: dict,
              llm_json: dict | None = None, dry_run: bool = False) -> dict:
    """One bounded research cycle. Pure planning unless dry_run=False, in
    which case validated proposals are submitted via the existing registry
    (the supervisor then executes them; this function trains nothing)."""
    from .orchestrate import ExperimentRegistry
    per_cycle = int(policy.get("research_max_per_cycle",
                           policy.get("max_experiments_per_cycle", DEFAULT_PER_CYCLE)))
    total_cap = int(policy.get("research_max_total", DEFAULT_TOTAL_BUDGET))
    reg = ExperimentRegistry(runs_root)
    submitted_count = sum(1 for e in reg.exps.values()
                          if e.get("status") not in ("FAILED",))
    outcomes = read_outcomes(runs_root)
    log = read_research_log(runs_root)
    best = best_edge_from(log)
    plan: dict = {"questions": [], "proposals": [], "submitted": [],
                  "conclusions": [], "skipped": []}
    concluded_ids = {r.get("experiment_id") for r in log if r.get("record") == "conclusion"}
    for o in outcomes:
        if o["experiment_id"] in concluded_ids:
            continue
        if o.get("eval") is None and o.get("status") in ("COMPLETED", "EVALUATED"):
            continue  # mid-lifecycle, not a result yet; evaluation pending
        cls = classify_outcome(o, best)
        record_conclusion(runs_root, {
            "experiment_id": o["experiment_id"], "outcome_class": cls["class"],
            "reason": cls["reason"], "edge": cls.get("edge"),
            "fingerprint": _try_fingerprint(o),
            "evidence": {"eval": bool(o.get("eval")),
                         "governance": (o.get("governance") or {}).get("outcome"),
                         "backtest_ok": (o.get("backtest") or {}).get("ok")}})
        plan["conclusions"].append(o["experiment_id"])
        if cls.get("edge") is not None and (best is None or cls["edge"] > best):
            best = cls["edge"]
    log = read_research_log(runs_root)
    classified = [{**o, "_class": classify_outcome(o, best)["class"]} for o in outcomes]
    questions = derive_questions(classified, log, [d for d in datasets])
    questions = questions[:per_cycle]
    base_hp = (policy.get("market_ml", {}) or {}).get("hyperparameters", {}) \
        if isinstance(policy.get("market_ml"), dict) else {}
    if not base_hp:
        base_hp = {"alpha": 0.0001}
    epochs = int(policy.get("default_epochs", 5))
    if submitted_count >= total_cap:
        plan["skipped"].append(f"total budget reached ({total_cap}); learning continues")
        questions = []
    if llm_json is not None:
        try:
            _validate_llm_proposal(llm_json, datasets, runs_root)
            plan["proposals"].append({"source": "llm", "definition": llm_json})
        except Exception as e:
            _append_record(runs_root, {"record": "llm_failure",
                                       "reason": f"malformed/unavailable LLM output: {e}"})
            plan["skipped"].append(f"llm: {e}")
    for qi, q in enumerate(questions):
        if submitted_count >= total_cap:
            plan["skipped"].append(f"total budget reached ({total_cap})")
            break
        if not any(r.get("id") == q["id"] for r in read_research_log(runs_root)
                   if r.get("record") == "question"):
            record_question(runs_root, q)
        plan["questions"].append({"id": q["id"], "question": q["question"],
                                  "topic": q.get("topic")})
        try:
            # Seed derives from the question: distinct questions explore
            # distinct configs; identical questions reproduce identical configs.
            qseed = 7 + (int(q["id"][-4:], 16) % 20)
            raw = propose_experiment(q, datasets, base_hp, seed=qseed, epochs=epochs,
                                     budget_note=f"cycle cap {per_cycle}, total cap {total_cap}",
                                     model_type=policy.get("market_ml", {}).get("model_type", "sgd-logloss")
                                     if isinstance(policy.get("market_ml"), dict) else "sgd-logloss")
            clean = validate_proposal(raw, runs_root, datasets)
        except Exception as e:
            plan["skipped"].append(f"{q['id']}: {e}")
            continue
        hyp = make_hypothesis(q, clean, clean["_fingerprint"],
                              baseline=None,
                              expectation=f"configuration {clean['hyperparameters']} improves edge vs baseline")
        if not any(r.get("id") == hyp["id"] for r in read_research_log(runs_root)
                   if r.get("record") == "hypothesis"):
            record_hypothesis(runs_root, hyp)
        plan["proposals"].append({"source": "deterministic", "hypothesis": hyp["id"],
                                  "definition": {k: v for k, v in clean.items()
                                                 if not k.startswith("_")}})
        if dry_run:
            continue
        try:
            rec = ExperimentRegistry(runs_root).submit(
                {k: v for k, v in clean.items() if not k.startswith("_")})
            submitted_count += 1
            plan["submitted"].append(rec["experiment_id"])
        except Exception as e:
            plan["skipped"].append(f"{q['id']}: submit refused: {e}")
    return plan


def _try_fingerprint(outcome: dict) -> str | None:
    try:
        from .orchestrate import experiment_id
        return experiment_id(outcome.get("definition", {}))
    except Exception:
        return None


def _validate_llm_proposal(defn: dict, datasets: list, runs_root: str) -> dict:
    """LLM output gets the identical schema/policy gate as deterministic
    proposals. Anything unsupported or fabricated is rejected."""
    if not isinstance(defn, dict):
        raise fail("INVALID_CONFIG", "LLM proposal is not an object")
    allowed = {"dataset_dir", "dataset_version", "model_type", "hyperparameters",
               "seed", "epochs", "device", "backtest_bars"}
    unknown = set(defn) - allowed
    if unknown:
        raise fail("INVALID_CONFIG", f"LLM proposal has unknown fields: {sorted(unknown)}")
    return validate_proposal(defn, runs_root, datasets)
