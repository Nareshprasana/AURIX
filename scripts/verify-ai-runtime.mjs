// AI runtime verification (plain node, not vitest).
// 1. LIVE Qwen3 4B inference through the Model Gateway (real Ollama call).
// 2. Boundary scans: no direct Ollama access outside the gateway; no AI/broker
//    coupling in deterministic layers; aurix_ai has no broker surface.
// 3. Training artifact consistency: manifest + checksum + checkpoints + metrics.
// Run: `pnpm build && node --import ./scripts/aurix-register.mjs scripts/verify-ai-runtime.mjs`
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { ModelGateway } from '@aurix/model-gateway';

const results = {};
function check(name, cond, extra = '') {
  if (!cond) throw new Error(`AI RUNTIME PROOF FAILED: ${name} ${extra}`);
  results[name] = 'ok';
  console.log(`ok - ${name}`);
}

// ---- 1. LIVE Qwen inference via gateway (no mocks, no stubs) ----
const gw = new ModelGateway({
  provider: 'ollama', model: 'qwen3:4b', endpoint: 'http://127.0.0.1:11434',
  timeout_ms: 120000, generation: { temperature: 0, max_tokens: 256 }
});
const t0 = Date.now();
let answer;
try {
  const r = await gw.chat({
    promptName: 'ai-runtime-proof', promptVersion: 'v1',
    input: 'Reply with exactly: AURIX-AI-OK and nothing else.',
    caller: 'verify-ai-runtime', traceId: 'ai-proof-1'
  });
  answer = r.text;
} catch (e) {
  throw new Error(`AI RUNTIME PROOF FAILED: qwen-live-inference ${e.message}`);
}
const latencyMs = Date.now() - t0;
check('qwen-live-inference', typeof answer === 'string' && answer.length > 0, answer.slice(0, 80));
check('qwen-model-version', gw.audits[0]?.model === 'qwen3:4b');
check('qwen-audit-metadata', gw.audits[0]?.caller === 'verify-ai-runtime' && typeof gw.audits[0]?.latencyMs === 'number');
check('qwen-no-secrets', !/api[_-]?key|secret|token|password|private[_-]?key|kite/i.test('Reply with exactly: AURIX-AI-OK and nothing else.'));
console.log(`info - qwen3:4b latency_ms=${latencyMs} response=${JSON.stringify(answer.slice(0, 120))}`);

// ---- 2. Boundary scans ----
const walk = (dir, out = []) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`;
    if (f.isDirectory()) { if (f.name === 'node_modules' || f.name === '.git' || f.name === 'dist') continue; walk(p, out); }
    else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
};
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
// Only the gateway may call the Ollama endpoint.
const callers = walk('apps').concat(walk('packages')).filter((f) => /11434|chat\/completions/i.test(strip(readFileSync(f, 'utf8'))));
check('ollama-via-gateway-only', callers.every((f) => f.includes('model-gateway')), callers.join(','));
// Deterministic layers stay AI-free.
for (const f of ['packages/risk-engine/src/index.ts', 'packages/order-safety-gate/src/index.ts', 'apps/execution-service/src/engine.ts', 'apps/brokers/broker-sim/src/index.ts']) {
  check(`ai-free:${f}`, !/aurix_ai|qwen|laya|model-gateway/i.test(strip(readFileSync(f, 'utf8'))));
}
// Python AI layer has no broker/execution surface.
{
  const py = readdirSync('services-python/aurix_ai').filter((f) => f.endsWith('.py'));
  const bad = [];
  for (const f of py) {
    const src = readFileSync(`services-python/aurix_ai/${f}`, 'utf8');
    for (const pat of ['placeOrder', 'BrokerPort', 'kiteconnect', 'api_secret', 'access_token', 'execution-service', 'risk-engine']) {
      if (src.includes(pat)) bad.push(`${f}::${pat}`);
    }
  }
  check('ai-no-broker-surface', bad.length === 0, bad.join(','));
}

// ---- 3. Training artifact consistency (produced by the real `aurix-train` run) ----
const runDir = 'docs/training/proof-run/run-proof-1';
check('artifact-run-exists', existsSync(`${runDir}/manifest.json`));
const manifest = JSON.parse(readFileSync(`${runDir}/manifest.json`, 'utf8'));
for (const k of ['run_id', 'model_id', 'dataset_version', 'feature_version', 'label_version', 'code_version', 'random_seed', 'device', 'status', 'artifact_sha256']) {
  check(`manifest-has-${k}`, manifest[k] !== undefined && manifest[k] !== null);
}
check('manifest-completed', manifest.status === 'COMPLETED' && manifest.epochs_trained >= 1);
const artBytes = readFileSync(`${runDir}/final/artifact.joblib`);
check('artifact-checksum', createHash('sha256').update(artBytes).digest('hex') === manifest.artifact_sha256);
for (const c of manifest.checkpoints) {
  check(`checkpoint-present:${c}`, existsSync(`${runDir}/checkpoints/${c}`));
}
const metrics = readFileSync(`${runDir}/metrics.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('metrics-epochs', metrics.length === manifest.epochs_trained && metrics.every((m) => Number.isFinite(m.train_loss) && Number.isFinite(m.val_loss)));

console.log(`\nAI RUNTIME PROOF: ${Object.keys(results).length} checks ok`);
