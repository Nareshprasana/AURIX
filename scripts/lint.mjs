// Minimal import-boundary lint for the Phase 1 safety path.
// Fails if deterministic safety packages import LLM/network/broker-secret code.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED = ['packages/risk-engine', 'packages/order-safety-gate', 'packages/portfolio-engine'];
const FORBIDDEN = [/from\s+['"]node:net['"]/, /from\s+['"]undici['"]/, /\bfetch\s*\(/, /kiteconnect/i, /broker-?secret/i, /\bOllama\b/, /chat\/completions/i, /model-gateway/i, /research-agents/i];

let failures = 0;
for (const pkg of GUARDED) {
  const src = join(ROOT, pkg, 'src');
  if (!existsSync(src)) continue;
  for (const f of readdirSync(src)) {
    if (!f.endsWith('.ts')) continue;
    const text = readFileSync(join(src, f), 'utf8');
    for (const re of FORBIDDEN) {
      if (re.test(text)) {
        console.error(`LINT FAIL ${pkg}/src/${f}: matches ${re}`);
        failures++;
      }
    }
  }
}
// Execution service must not import model-gateway or research code.
import { readdirSync as readdirSyncExec } from 'node:fs';
const EXEC_FILES = ['apps/execution-service/src/index.ts'];
try {
  for (const f of readdirSyncExec(join(ROOT, 'apps/execution-service/src'))) {
    if (f.endsWith('.ts')) EXEC_FILES.push(`apps/execution-service/src/${f}`);
  }
} catch { /* ignore */ }
for (const rel of [...new Set(EXEC_FILES)]) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/model-gateway|research-agents|ml-training/i.test(text)) {
    console.error(`LINT FAIL ${rel}: execution must not import LLM/research/training`);
    failures++;
  }
  if (/api[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key/i.test(text)) {
    console.error(`LINT FAIL ${rel}: execution must not embed broker secrets`);
    failures++;
  }
}
// Execution interface: no network/fetch/secrets/LLM; broker-kite: no HTTP/SDK/fetch.
const EXEC_IFACE_FILES = ['packages/execution-interface/src/index.ts'];
for (const rel of EXEC_IFACE_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/\bfetch\s*\(|from\s+['"]node:net['"]|kiteconnect|model-gateway|research-agents|ml-training/i.test(text)) {
    console.error(`LINT FAIL ${rel}: execution-interface must stay network/LLM/broker-SDK free`);
    failures++;
  }
}
const KITE_FILES = ['apps/brokers/broker-kite/src/index.ts'];
for (const rel of KITE_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/\bfetch\s*\(|axios|kiteconnect|from\s+['"]node:(net|https?)['"]/i.test(text)) {
    console.error(`LINT FAIL ${rel}: kite-disabled must contain no live transport`);
    failures++;
  }
  if (/api[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key/i.test(text)) {
    console.error(`LINT FAIL ${rel}: kite-disabled must not embed secrets`);
    failures++;
  }
}
// Broker-sim: no real credentials, no live transport.
{
  const p = join(ROOT, 'apps/brokers/broker-sim/src/index.ts');
  if (existsSync(p)) {
    const text = readFileSync(p, 'utf8');
    if (/\bfetch\s*\(|axios|kiteconnect|from\s+['"]node:net['"]/i.test(text)) {
      console.error('LINT FAIL apps/brokers/broker-sim/src/index.ts: sim must not use live transport');
      failures++;
    }
  }
}
// Knowledge service owns graph writes: no LLM/broker/training/network imports.
const KNOWLEDGE_FILES = ['apps/knowledge-service/src/index.ts', 'apps/knowledge-service/src/store.ts', 'apps/knowledge-service/src/tables.ts', 'apps/knowledge-service/src/policy.ts', 'apps/knowledge-service/src/secrets.ts', 'apps/knowledge-service/src/hash.ts', 'apps/knowledge-service/src/export.ts', 'apps/knowledge-service/src/sqlite.ts'];
for (const rel of KNOWLEDGE_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/model-gateway|broker-sim|broker-kite|kiteconnect|research-agents|ml-training|from\s+['"]node:net['"]|\bfetch\s*\(/i.test(text)) {
    console.error(`LINT FAIL ${rel}: knowledge core must not import LLM/broker/training/network`);
    failures++;
  }
}
// Sync engine: transport only. No broker/execution/risk/research/training/gateway imports.
const SYNC_FILES = ['apps/sync-manager/src/manager.ts', 'apps/sync-manager/src/transport.ts', 'apps/sync-manager/src/identity.ts', 'apps/sync-manager/src/crypto.ts'];
for (const rel of SYNC_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/@aurix\/broker|@aurix\/execution|@aurix\/risk|research-agents|ml-training|model-gateway|kiteconnect|from\s+['"]node:net['"]/i.test(text)) {
    console.error(`LINT FAIL ${rel}: sync engine must not import broker/execution/risk/research/training/gateway`);
    failures++;
  }
}
// Transports move opaque files: no knowledge-store imports beyond the facade (none at all here).
{
  const text = readFileSync(join(ROOT, 'apps/sync-manager/src/transport.ts'), 'utf8');
  if (/knowledge-service|KnowledgeStore/i.test(text)) {
    console.error('LINT FAIL apps/sync-manager/src/transport.ts: transport must not import the knowledge store');
    failures++;
  }
}
// Memory + market-data: no broker/execution/live-trading/research-agent/training/gateway/network imports.
const PHASE4_FILES = [
  'packages/market-data/src/types.ts',
  'packages/market-data/src/quality.ts',
  'packages/market-data/src/events.ts',
  'apps/memory-manager/src/manager.ts',
  'apps/memory-manager/src/freshness.ts'
];
for (const rel of PHASE4_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/@aurix\/broker|@aurix\/execution|research-agents|ml-training|model-gateway|kiteconnect|from\s+['"]node:/i.test(text)) {
    console.error(`LINT FAIL ${rel}: phase 4 info layer must stay broker/execution/research/training/gateway/network-free`);
    failures++;
  }
}
// Research agents: observations only. No broker/execution/risk/portfolio/gateway,
// no order-construction identifiers, no training.
const RESEARCH_FILES = [
  'apps/research-agents/src/types.ts',
  'apps/research-agents/src/sources.ts',
  'apps/research-agents/src/context.ts',
  'apps/research-agents/src/orchestrator.ts',
  'apps/research-agents/src/agents/fundamental.ts',
  'apps/research-agents/src/agents/technical.ts',
  'apps/research-agents/src/agents/valuation.ts',
  'apps/research-agents/src/agents/sentiment.ts',
  'apps/research-agents/src/agents/macro.ts',
  'apps/research-agents/src/agents/events.ts'
];
for (const rel of RESEARCH_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/@aurix\/(broker-sim|broker-kite|execution-service|risk-engine|portfolio-engine|model-gateway)|research-agents/i.test(text)) {
    console.error(`LINT FAIL ${rel}: research must not import broker/execution/risk/portfolio/gateway`);
    failures++;
  }
  if (/\bplaceOrder\b|BrokerPort|kiteconnect/i.test(text)) {
    console.error(`LINT FAIL ${rel}: research must not construct orders`);
    failures++;
  }
}
// Strategy/backtest: simulation only. No broker/execution/live-trading, no
// dynamic code execution, no training coupling, no gateway.
const STRATEGY_FILES = [
  'packages/strategy/src/types.ts',
  'packages/strategy/src/indicators.ts',
  'packages/strategy/src/families.ts',
  'packages/strategy/src/regime.ts',
  'packages/strategy/src/costs.ts',
  'packages/strategy/src/metrics.ts',
  'packages/strategy/src/signals.ts',
  'apps/backtest/src/datasets.ts',
  'apps/backtest/src/engine.ts',
  'apps/backtest/src/methods.ts',
  'apps/backtest/src/registry.ts',
  'apps/backtest/src/hypothesis.ts',
  'apps/backtest/src/integration.ts'
];
for (const rel of STRATEGY_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/@aurix\/(broker-sim|broker-kite|execution-service|risk-engine|portfolio-engine|model-gateway)|research-agents|ml-training|kiteconnect/i.test(text)) {
    console.error(`LINT FAIL ${rel}: strategy layer must not touch broker/execution/risk/portfolio/gateway/training`);
    failures++;
  }
  if (/\bplaceOrder\b|BrokerPort/i.test(text)) {
    console.error(`LINT FAIL ${rel}: strategy layer must not construct real orders`);
    failures++;
  }
  if (/\beval\s*\(|new Function\s*\(|child_process|execSync|spawnSync/i.test(text)) {
    console.error(`LINT FAIL ${rel}: no dynamic code execution in strategy layer`);
    failures++;
  }
}
// Portfolio/risk layer: hypothetical decisions only. No broker/execution/live-trading,
// no gateway/training/research coupling, no dynamic code, no secrets handling.
const PORTFOLIO_FILES = [
  'packages/portfolio/src/types.ts',
  'packages/portfolio/src/capital.ts',
  'packages/portfolio/src/allocation.ts',
  'packages/portfolio/src/risk.ts',
  'packages/portfolio/src/sizing.ts',
  'packages/portfolio/src/rebalance.ts',
  'apps/portfolio-service/src/service.ts'
];
for (const rel of PORTFOLIO_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/@aurix\/(broker-sim|broker-kite|execution-service|risk-engine|portfolio-engine|model-gateway)|research-agents|ml-training|kiteconnect/i.test(text)) {
    console.error(`LINT FAIL ${rel}: portfolio layer must not touch broker/execution/risk-live/gateway/research/training`);
    failures++;
  }
  if (/\bplaceOrder\b|BrokerPort/i.test(text)) {
    console.error(`LINT FAIL ${rel}: portfolio layer must not construct real orders`);
    failures++;
  }
  if (/\beval\s*\(|new Function\s*\(|child_process|execSync|spawnSync/i.test(text)) {
    console.error(`LINT FAIL ${rel}: no dynamic code execution in portfolio layer`);
    failures++;
  }
}
if (failures > 0) {
  console.error(`${failures} lint violation(s)`);
  process.exit(1);
}
console.log('lint ok: safety-path import boundaries hold');
