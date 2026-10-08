# AURIX — Autonomous Unified Risk & Intelligence eXchange

Local-first autonomous financial intelligence and trading platform for Indian
markets (Phases 1–8 complete and audited), plus an isolated AI/training layer
(Qwen3 4B reasoning, Laya System-1, small numerical market model).

Safety first: deterministic risk, the Order Safety Gate, execution controls,
kill switches, and promotion gates remain authoritative. AI outputs are
advisory only and can never enable live trading.

## Prerequisites

- Python 3.14 (AI/training; anything `>=3.11` per `services-python/pyproject.toml`)
- Node 24 + pnpm 11 (TypeScript app, tests, verification scripts)
- Ollama 0.40+ with `qwen3:4b` pulled (`ollama list` must show it)
- Optional GPU: NVIDIA GTX 1650 4 GB was used for Qwen serving; numerical
  training and Laya run on CPU by default (torch CPU build, safe fallback)

## Python environment

AURIX AI/training dependencies live in the root `.venv` (isolated, never
global). System Python is not used by AURIX AI.

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
```

Verify the venv owns the packages:

```powershell
.\.venv\Scripts\python -c "import sys; print(sys.prefix)"
.\.venv\Scripts\python -c "import laya, torch, sklearn; print(laya.__version__, torch.__version__, sklearn.__version__)"
```

## Dependencies

`requirements.txt` is the single source for Python AI/training dependencies
(pinned direct deps: `numpy`, `scikit-learn`, `joblib`, `pyyaml`, `torch`
CPU build, `laya`, plus `pytest` for verification). Transitives resolve via
pip. Ollama is **not** a Python dependency — it is an external local runtime.

## Qwen

- Qwen3 4B served by local Ollama (`http://127.0.0.1:11434`), model
  `qwen3:4b` configured in `config/ai-policy.v1.yaml` (configurable, never
  hardcoded).
- All access goes through the AURIX Model Gateway (`apps/model-gateway`),
  which owns validation, secret redaction, audit metadata, and version
  tracking. No application component may call Ollama directly.
- Reasoning/synthesis only — never authoritative for risk, margin,
  eligibility, kill switches, or execution.

## Laya

- Laya 0.4.0 (`pip install laya`, inside `.venv`): fast System-1 structured
  decisions (`Agent.predict`/`decide`, calibration fitting, `laya-train`
  fine-tuning CLI). Used in `services-python/aurix_ai/laya_component.py`.
- CPU by default to respect the shared 4 GB GPU budget (Ollama serves Qwen
  there). Signals are advisory, subordinate to
  Portfolio → Risk → Safety Gate → Execution.

## Training

Small numerical model (SGD logistic regression, `services-python/aurix_ai/`):

```powershell
cd services-python
..\.venv\Scripts\python -c "import sys; from aurix_ai.cli import main; sys.exit(main(['dataset','--out','<dir>']))"
..\.venv\Scripts\python -c "import sys; from aurix_ai.cli import main; sys.exit(main(['train','--dataset','<ds>','--out','<runs>','--run','<id>']))"
```

Exact CLI: `aurix-train resources|dataset|train|resume|evaluate|laya-probe|laya-decide|registry`
(installed as `aurix-train` only if the package is pip-installed; otherwise
invoke via `python -c "from aurix_ai.cli import main; ..."` from `services-python/`).

## Checkpoints

Immutable per-epoch `.npz` files (`checkpoints/checkpoint-NNNN.npz`) holding
params, scaler state, optimizer step, epoch, config, and versions.
`aurix-train resume --run-dir <dir> --dataset <ds> --epochs <n>` continues the
same run without overwriting earlier checkpoints.

## Model artifacts

Final `artifact.joblib` + `manifest.json` (checksum, versions, device, seed)
per run. New models register as `CANDIDATE` in the registry and **never**
auto-activate — promotion is explicit (`CANDIDATE→VALIDATED→PAPER→APPROVED→ACTIVE`).
Large Laya checkpoints stay outside Git (see `.gitignore`).

## Verification

```powershell
pnpm test            # full TypeScript suite
pnpm typecheck; pnpm lint; pnpm build
..\.venv\Scripts\python -m pytest tests -q        # from services-python/
pnpm verify:ai       # live Qwen check + artifact consistency (needs Ollama)
```

Phase proof scripts: `pnpm verify:cumulative|strategy|portfolio|execution`
(plus sqlite/knowledge/sync/memory/research).

## Historical Data

- Primary source: **tej-bazaar** (`tejhq/indian-markets`, NSE 2010→today EOD OHLCV, raw bhavcopy); secondary validation: **eod2_data** (adjusted CSVs). See `docs/history-data.md` for the full evaluation.
- Setup: none beyond `.venv` (stdlib `urllib` only — no new dependencies).
- Acquisition: `aurix-train history-fetch --symbols RELIANCE,INFY --from-date 2022-01-01 --to-date 2024-12-31 --provider tej --out data` (run from `services-python/` with `../.venv` python; same pattern as Training above).
- Dataset generation: `aurix-train history-build --symbols ... --provider tej --out data --cross-check` → validated rows, quality report, training dataset (`data/datasets/`), backtest bars (`data/processed/`).
- Validation: `PASS`/`QUARANTINE`/`BLOCK` with preserved reasons; manifests carry source, schema version, adjustment policy, checksums.
- Licensing: MIT code upstream; exchange data stored locally only, no redistribution claimed (`LICENSE_STATUS(data-redistribution) = UNKNOWN`).
- Training usage: emitted datasets load via the existing `train`/`evaluate` commands (compat run verified).
- Backtesting usage: `node --import ./scripts/aurix-register.mjs scripts/verify-history-data.mjs <dataset-version>` runs real bars through `buildDataset` + `runBacktest` (integrity proof, not a profitability claim).

## Automated Training

- Start: `aurix train` from the repo root — no arguments needed. It submits
  default experiments (if none active), starts the detached supervisor, and
  returns while workers continue independently. Details: `docs/training/automation.md`.
- One heavy job at a time; workers are independent processes with checkpoint resume; governance promotes to VALIDATED only (accuracy edge + backtest gate), never beyond — PAPER+ stays operator-only.
- Existing run directories are immutable: nothing may delete/overwrite/reuse them; test cleanup uses isolated temp roots only.

## Resource usage

Designed for the available box (4 GB GPU, CPU fallback everywhere): lightweight
SGD model, CPU Laya, small Ollama context, per-run isolated training dirs, no
Docker/Kubernetes/distributed training, no new services.
