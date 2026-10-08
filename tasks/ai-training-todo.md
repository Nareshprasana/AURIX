# AURIX AI Training TODO

## Config
- [ ] `config/ai-policy.v1.yaml`

## Python package `services-python/aurix_ai/`
- [ ] `__init__.py`, `errors.py`, `resources.py`, `signals.py`
- [ ] `datasets.py` (gen/validate/features/labels/version/split/leakage)
- [ ] `model.py` (SGD + scaler, checkpoint save/load, resume)
- [ ] `train.py` (manifest, metrics, run/resume, evaluate, artifact)
- [ ] `registry.py` (states + explicit promote)
- [ ] `laya_component.py` (probe + decide + calibration fallback)
- [ ] `cli.py` (`aurix-train`) + pyproject scripts entry + deps

## Tests
- [ ] `test_ai_dataset.py`, `test_ai_train.py` (real tiny train + resume equality)
- [ ] `test_ai_registry.py`, `test_ai_laya.py` (surface only), `test_ai_security.py`, `test_ai_resources.py`
- [ ] TS `apps/model-gateway/test/qwen.test.ts`

## Runtime proofs (actually executed)
- [ ] `aurix-train` full run + resume + artifact + inference
- [ ] Qwen live via gateway (latency recorded)
- [ ] Laya real decide (or exact blocker) + calibration op
- [ ] `docs/training/training-proof-of-execution.md` with measured numbers

## Verification + commit
- [ ] pytest, pnpm test, typecheck, lint, build, all verify scripts + new `verify:ai`
- [ ] focused commits + final report (no Phase 9, no live trading)
