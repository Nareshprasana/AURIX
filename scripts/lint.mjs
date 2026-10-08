// Minimal import-boundary lint for the Phase 1 safety path.
// Fails if deterministic safety packages import LLM/network/broker-secret code.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
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
const EXEC_FILES = ['apps/execution-service/src/index.ts'];
for (const rel of EXEC_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (/model-gateway|research-agents|ml-training/i.test(text)) {
    console.error(`LINT FAIL ${rel}: execution must not import LLM/research/training`);
    failures++;
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
if (failures > 0) {
  console.error(`${failures} lint violation(s)`);
  process.exit(1);
}
console.log('lint ok: safety-path import boundaries hold');
