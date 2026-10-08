# AURIX Training Proof of Execution

All numbers below were measured from actual execution on this machine. No mock
output, no fabricated metrics, no fake checkpoints. Every command exists in the
repository (`aurix-train` is defined in `services-python/pyproject.toml`;
`verify:ai` is defined in the root `package.json`).

## Environment

- OS: Windows
- Python: 3.14.4
- Node: v24.15.0
- numpy 2.5.3, scikit-learn 1.9.1, joblib 1.6.0, pyyaml 6.0.3
- PyTorch: 2.14.1+cpu — CUDA available: **False** (CPU-only build installed)
- Laya: 0.4.0 (installed via `pip install laya`; deps: transformers 5.19.0,
  tokenizers 0.23.2, safetensors 0.8.0, torch 2.14.1+cpu). Python requirement
  satisfied by 3.14. Checkpoint format: safetensors (`model.safetensors`) +
  tokenizer + `rl_agent_config.json` + `questions.json`. CPU/GPU: `device`
  parameter (`cpu`/`cuda`/`auto`); training CLI `laya-train` exposes `--device`.
- Ollama: 0.40.0. Model `qwen3:4b` present (`ollama list`: 359d7dd4bcda,
  2.5 GB, architecture qwen3, 4.0B params, Q4_K_M, context 262144).
- GPU: NVIDIA GeForce GTX 1650, 4096 MB total (nvidia-smi, driver 595.97,
  CUDA driver 13.2). VRAM in use at detection: 0 MB (first probe), 2297 MB
  during training (desktop + Ollama resident). torch-CUDA unavailable, so the
  numerical workload ran on CPU by policy (`auto` → CPU fallback, recorded in
  the manifest). No OOM was forced; Qwen serving stays inside Ollama, Laya
  inference/training was pinned to CPU to respect the shared 4 GB budget.

## Dataset

- Dataset ID: `aurix-synth-daily`, version `aurix-synth-daily-1b5a788891b5`
  (content-hash version; any spec change yields a new version).
- Source: seeded synthetic OHLCV (`seed=7`), 750 daily bars × 2 instruments
  (`NSE_EQ_RELIANCE`, `NSE_EQ_INFY`), range 1700000000000–1764281600000.
- Features (8, `feat-v1`, causal, max lookback 20 bars): `ret_1..ret_5`,
  `mom_10`, `vol_10`, `vol_ratio`. Every feature at bar T uses closes/volumes
  with index ≤ T only (verified by code inspection + unit test recomputing a
  label from raw closes).
- Label (`label-v1`): 1 if `close[T+5]/close[T]-1 > 0.005` else 0. Future data
  appears ONLY in the target definition.
- Rows: 1450 (pos 655 / neg 795). Checksum
  `sha256:827ece8f339ec53f6954d08b03d4f47d9d076ae3085f3364c817fb4c432bb432`.
- Chronological split (no shuffling): TRAIN 870 rows
  [1701728000000, 1739225600000] → VAL 290 rows [1739312000000, 1751753600000]
  → TEST/OOS 290 rows [1751840000000, 1764281600000]. Ranges never overlap.
- Leakage checks: feature whitelist (no `fwd`/future columns exist),
  scaler fitted on TRAIN rows only (unit test asserts scaler mean equals train
  mean and differs from train+val mean), split timestamp ordering asserted.
- Datasets are immutable: rewrite with identical bytes is a no-op; any byte
  difference raises `DATASET_CORRUPT`; checksum re-verified on every load.
- Command: `aurix-train dataset --out docs/training/proof-run/datasets --seed 7 --bars 750`

## Training

- Run ID: `run-proof-1`, model `sgd-logloss` (SGDClassifier log-loss,
  `alpha=0.0001`, `random_state=7`, `shuffle=False`), `StandardScaler` via
  streaming `partial_fit` on TRAIN only. Device: `cpu` (policy `auto` →
  `torch-CUDA unavailable; CPU fallback`). Seed 7. Config hash `3fad723cd92ee947`.
- Phase 1: 3 epochs / 3 steps in 1.56 s (~1670 train rows/s).
- Resume from `checkpoint-0003.npz`: +2 epochs / 2 steps → 5 epochs total.
- Measured per-epoch telemetry (`metrics.jsonl`):
  - ep1 train_loss 12.5318, val_loss 14.5709
  - ep2 train_loss 9.7412, val_loss 11.2849
  - ep3 train_loss 7.5049, val_loss 8.3311
  - ep4 train_loss 6.3668, val_loss 7.5049 (resumed)
  - ep5 train_loss 5.8205, val_loss 6.5955 (resumed)
  Loss decreases monotonically and continues across the resume boundary,
  proving training resumed rather than restarted (unit test additionally
  proves exact coefficient equality vs an uninterrupted 4-epoch run).
- OOS TEST evaluation (n=290, pos_rate 0.452): accuracy 0.5586,
  precision 0.5116, recall 0.5038 vs majority baseline 0.5483. This is a weak
  synthetic-data signal and is NOT presented as profitability; strategic use
  requires the existing backtest/OOS framework first.
- Commands: `aurix-train train --dataset <ds> --out docs/training/proof-run --run run-proof-1 --epochs 3`,
  then `aurix-train resume --run-dir docs/training/proof-run/run-proof-1 --dataset <ds> --epochs 2`,
  then `aurix-train evaluate --run-dir ... --dataset <ds>`.
- Reproducibility: re-running train+resume produced the identical final
  artifact checksum (`5366c348...`, deterministic under fixed seed/order).

## Checkpoint

- Created: `checkpoint-0001.npz` … `checkpoint-0005.npz` (3.4 KB each),
  each holding `coef_`, `intercept_`, scaler mean/var/n, epoch, step,
  optimizer schedule `t_`, plus meta (run/epoch/dataset/feature/label
  versions, seed, config).
- Loaded: `checkpoint-0003.npz` reloaded into a fresh model (`resume`
  command output names it explicitly).
- Resume verified: epochs 4–5 losses continue the ep1–3 curve; manifest
  records `epochs_trained=5, steps=5`; checkpoints are never overwritten
  (existing files are kept, new epochs append).
- Corruption handling: missing/unparseable checkpoint raises
  `CHECKPOINT_CORRUPT` (unit-tested failure path); training refuses to
  continue without valid state.

## Artifact

- Path: `docs/training/proof-run/run-proof-1/final/artifact.joblib`
  (`{coef, intercept, scaler_mean, scaler_var, alpha, classes}`).
- Checksum: `sha256:5366c348a4a6bfa820fb2928468f24d422da3fe166b0b018ab01390d9d3d0b4d`
  (recorded in `manifest.json`, re-verified by `verify:ai` via hash recompute).
- Loaded: yes — `aurix-train evaluate` loads the artifact with joblib and runs
  OOS inference (290 test rows, metrics above); artifact-loading is also
  unit-tested. Immutable: re-finalizing a completed run without resume is refused.
- Registry: `aurix-marketml-run-proof-1` registered as **CANDIDATE**
  (`docs/training/proof-run/registry.json`). Promotion is explicit-only
  (`CANDIDATE→VALIDATED→PAPER→APPROVED→ACTIVE`); skip-transitions are rejected
  (unit-tested). Nothing auto-activates.

## Ollama

- Qwen model detected: `qwen3:4b` via `GET /api/tags` on the configured
  endpoint `http://127.0.0.1:11434` (model name from `config/ai-policy.v1.yaml`,
  not hardcoded — gateway test swaps it).
- Inference executed through the Model Gateway (the ONLY Ollama caller;
  scan-verified): prompt `Reply with exactly: AURIX-AI-OK and nothing else.`
- Response received: `"AURIX-AI-OK"`. Latency recorded: 17156 ms
  (gateway audit `latency_ms`; model/version/caller/trace recorded).
- Secrets: prompt secret-scanned by the gateway; `SECRET_REDACTED` on
  secret-shaped input (unit-tested). Qwen is reasoning-only — never
  authoritative for risk, margin, eligibility, kill switches, or execution.

## Laya

- Version: 0.4.0 (Python 3.14). Capabilities probed from the installed package:
  `decide`, `Agent`, `confidence_from_probs`, `fit_temperature_map` all present;
  training CLI `laya-train` available with documented flags
  (`--data/--eval/--out/--base/--epochs/--micro-batch/--grad-accum/--encoder-lr/--head-lr/--loss/--freeze-encoder/--device/--seed/--dry-run`).
- Inference verified (real `Agent` on CPU, checkpoint `convaiinnovations/laya`
  auto-downloaded to HF cache): state `NSE_EQ_RELIANCE daily momentum long
  candidate`, questions `direction` (choice LONG/SHORT/HOLD) + `risk_ok`
  (noul). Output: `direction=LONG` (p 0.7843/0.1058/0.1099),
  `risk_ok` P(true)=0.1791, 99 input tokens, saved to
  `docs/training/proof-run/laya-decision.json`. Note: laya emitted a
  calibration RuntimeWarning (shipped temperatures out of range → 0.5
  fallback); confidences treated as uncalibrated.
- Training verified (real `laya-train`): 8-row CSV (`training-data.csv`
  committed), `--epochs 1 --freeze-encoder --device cpu --seed 7` →
  `epoch 1/1 mean loss 1.6731`, `Training complete! Model saved`. Checkpoint
  format: `model.safetensors` + tokenizer + `rl_agent_config.json` +
  `questions.json` + `train_report.json`. The 842 MB weights file was
  relocated out of the repo (report + configs + training CSV committed);
  reproducible via the documented command. Eval note: 0 calibration items and
  no `--eval` set, so `train_report.json` honestly records no generalization
  comparison (its own words: "skipping evaluation to avoid reporting training
  fit as generalization").
- Calibration op verified: `fit_temperature_map` on 60 synthetic
  (logits, one-hot target) records returns a non-empty temperature map
  (unit-tested).
- Device: CPU for both inference and training (torch CPU-only build; GPU
  budget reserved for Ollama/Qwen). Laya signals are advisory System-1 only,
  subordinate to Portfolio → Risk → Safety Gate → Execution.

## Verification

- `pytest services-python/tests`: 37 passed (22 pre-existing + 15 new AI tests).
- `pnpm test` (vitest): full suite green including new
  `apps/model-gateway/test/qwen.test.ts` (4 tests).
- `typecheck` (`tsc --noEmit`): clean. `lint`: clean. `build`: clean.
- Cumulative + all phase verifies: `verify:sqlite/knowledge/sync/memory/
  research/cumulative/strategy/portfolio/execution` all pass (regression-free).
- `verify:ai` (`pnpm verify:ai`): 29 checks ok — live Qwen inference, audit
  metadata, gateway-only Ollama access, AI-free deterministic layers,
  artifact checksum recompute, all 5 checkpoints present, metrics consistency.
- Exact training CLI: `aurix-train` (`services-python/pyproject.toml`
  `[project.scripts]` → `aurix_ai.cli:main`; subcommands
  `resources|dataset|train|resume|evaluate|laya-probe|laya-decide|registry`).

## Security

- `aurix_ai` contains zero broker/execution/secret surface (`placeOrder`,
  `BrokerPort`, `kiteconnect`, tokens, `execution-service`, `risk-engine`
  all absent — scan-tested in unit tests and `verify:ai`).
- No Qwen prompt, Laya input, dataset, artifact, log, or checkpoint carries
  secrets (gateway redaction + `assert_no_secrets` on signal construction).
- No broker execution path added; Order Safety Gate, risk engine, execution
  state machine, kill switches, and promotion controls untouched (all prior
  suites green).
- Live trading remains disabled; the trained model is `CANDIDATE` only and
  cannot silently become active. Prompt injection has no path to execution
  (AI outputs are data, never authority).
