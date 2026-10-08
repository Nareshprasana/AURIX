# AURIX AI Training Plan — Qwen3 4B + Laya + Market ML (additive, Phases 1–8 protected)

Baseline: Phase 8 `ccdbb4d` + audit `0ec77e9` (PASS). No modification to risk,
safety gate, execution, broker, kill switches, promotion, knowledge, memory, sync,
research, strategy, backtest, portfolio pipelines. AI outputs are subordinate
observations; nothing auto-activates.

## Components (new code only)

- `config/ai-policy.v1.yaml` — llm (provider/model/endpoint/generation), laya
  (device/max_len/confidence), market-ml (model/hyperparams/label threshold),
  training (device policy/epochs/seed/checkpointing), registry policy. Model name
  configurable; nothing hardcoded in app code.
- `services-python/aurix_ai/` — NEW package (existing `aurix_py/` untouched):
  `resources` (GPU/CUDA/VRAM detect + safe device select + CPU fallback),
  `signals` (MarketModelPrediction / LayaDecisionSignal / LLMReasoningResult —
  distinct, non-interchangeable, secret-scanned), `datasets` (seeded OHLCV →
  validate → quality gate → causal features → forward labels → versioned
  immutable dataset + checksum → chronological TRAIN/VAL/TEST), `model`
  (SGD log-loss + StandardScaler partial_fit; npz checkpoints with
  params/optimizer/epoch/step/config/versions/seed), `train` (run manifest,
  metrics.jsonl, checkpoint/resume, OOS eval: acc/prec/rec/baseline/windows),
  `registry` (CANDIDATE→VALIDATED→PAPER→APPROVED→ACTIVE + RETIRED/REJECTED,
  explicit promote only), `laya_component` (version/API probe, lazy CPU Agent,
  calibration-fit fallback), `errors` (typed failures), `cli` (`aurix-train`:
  resources|dataset|train|resume|evaluate|laya-probe|registry).
- TS: `scripts/verify-ai-runtime.mjs` (gateway→Qwen LIVE check + boundary scans
  + artifact/manifest consistency) + `apps/model-gateway/test/qwen.test.ts`
  (config swap, redaction, audit). Gateway src untouched.
- `docs/training/training-proof-of-execution.md` — real measured numbers only.
- Proof artifacts committed under `docs/training/proof-run/` (tiny); ad-hoc
  runs go to gitignored `training_runs/`.

## Proofs (all actually executed)

Dataset→features→labels→split→train→validate→ckpt→resume→test→inference;
Qwen live inference via gateway (latency recorded); Laya real Agent decide or
documented blocker + calibration-fit op; torch-CUDA absent → CPU fallback
recorded; GPU (GTX 1650 4GB) info via nvidia-smi.

## Safety

No broker/secret/execution imports in `aurix_ai` (tested); prompts secret-scanned;
registry never auto-activates; training isolated per-run dirs; knowledge refs
written as import-ready OBSERVATION jsonl (never auto-committed).
