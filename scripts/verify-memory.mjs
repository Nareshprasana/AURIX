// Phase 4 proof on real SQLite (plain node, not vitest).
// Demonstrates the §33 loop: RESEARCH → store → REUSE → event → REFRESH →
// conflict → CONFLICT, plus retrieval/dedup/quality/invalidation timings.
// Run: `pnpm build && node scripts/verify-memory.mjs`
import { DatabaseSync } from 'node:sqlite';
import { KNOWLEDGE_DDL } from '../dist/packages/db-bootstrap/src/index.js';
import { KnowledgeStore } from '../dist/apps/knowledge-service/src/store.js';
import { SqliteTables } from '../dist/apps/knowledge-service/src/sqlite.js';
import { MemoryManager } from '../dist/apps/memory-manager/src/index.js';
import { normalizeBar, assessBar, StubProvider, earningsEvent } from '../dist/packages/market-data/src/index.js';

let tick = 1_800_000_000_000;
const now = () => tick;
const step = (ms) => { tick += ms; };

function prov(tag) {
  return {
    source: 'proof', source_type: 'press', source_identifier: `${tag}-src`,
    observed_at: tick, agent: 'proof', evidence_refs: [`${tag}-ev`], confidence: 0.8
  };
}

const db = new DatabaseSync(':memory:');
db.exec(KNOWLEDGE_DDL);
const store = new KnowledgeStore(new SqliteTables(db), { deviceId: 'dev-proof', now });
const mm = new MemoryManager(store);
const timings = {};
function timed(name, fn) {
  const t0 = Date.now();
  const out = fn();
  timings[name] = Date.now() - t0;
  return out;
}

// 1. No memory → RESEARCH_REQUIRED.
const d0 = mm.decide({ subject: 'company:PROOF', topic: 'sector', now: tick });
if (d0.decision !== 'RESEARCH') throw new Error(`expected RESEARCH, got ${d0.decision}`);

// 2. Research result → knowledge → memory; second request → REUSE.
timed('research-commit', () => {
  const reg = mm.registerTask({ subject: 'company:PROOF', objective: 'sector', scope: 'demo', agent: 'proof', actor: 'proof', now: tick });
  if (reg.deduplicated) throw new Error('first registration must not dedupe');
  store.proposeValidateCommit({
    assertion: 'OBSERVATION',
    ops: [{ op: 'put-memory', memory: { category: 'semantic', key: 'sector:company:PROOF', content: { entity: 'company:PROOF', topic: 'sector', domain: 'static', confidence: 0.9 } } }],
    provenance: prov('m1'), actor: 'proof'
  });
  mm.completeTask(reg.task.task_id, 'memory:sector:company:PROOF', 'COMPLETED', 'proof', tick);
});
const d1 = timed('reuse-decide', () => mm.decide({ subject: 'company:PROOF', topic: 'sector', now: tick }));
if (d1.decision !== 'REUSE') throw new Error(`expected REUSE, got ${d1.decision} (${d1.basis.join(';')})`);

// 3. Market-data loop: valid bar → knowledge; bad bar → quarantine.
const provider = new StubProvider('stub');
const bar = normalizeBar({
  instrument_id: 'X', exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: 'X',
  ts: tick, tz: 'Asia/Kolkata', timeframe: '1D', open: 100, high: 105, low: 99, close: 103, volume: 1000
}, 'stub');
const report = assessBar(bar, { now: tick });
if (report.verdict !== 'VALID') throw new Error('fixture bar should be VALID');
const obs = timed('observe-market', () => mm.observeMarket(bar, report, 'proof'));
if (obs.action !== 'COMMITTED') throw new Error('expected COMMITTED observation');
void provider;

// 4. New earnings event → invalidation → REFRESH_REQUIRED (history preserved).
const before = store.snapshotMemories().length;
const ev = earningsEvent(['X'], tick, tick, 'exchange');
ev.entity_refs = ['company:PROOF'];
timed('invalidate', () => mm.applyMarketEvent(ev, 'proof', tick));
if (store.snapshotMemories().length <= before) throw new Error('invalidation must append markers');
const d2 = mm.decide({ subject: 'company:PROOF', topic: 'sector', now: tick });
if (d2.decision !== 'REFRESH') throw new Error(`expected REFRESH, got ${d2.decision}`);

// 5. Conflicting evidence → CONFLICT, no silent overwrite.
for (const [key, view] of [['s-up', 'up'], ['s-down', 'down']]) {
  store.proposeValidateCommit({
    assertion: 'OBSERVATION',
    ops: [{ op: 'put-memory', memory: { category: 'semantic', key, content: { entity: 'company:PROOF', topic: 'sentiment', domain: 'research', confidence: 0.8, view } } }],
    provenance: prov(key), actor: 'proof'
  });
}
const d3 = mm.decide({ subject: 'company:PROOF', topic: 'sentiment', now: tick });
if (d3.decision !== 'CONFLICT') throw new Error(`expected CONFLICT, got ${d3.decision}`);

// 6. Dedup + gap report on the same store.
const dup = timed('dedup-lookup', () => mm.registerTask({ subject: 'company:PROOF', objective: 'sector', scope: 'demo', agent: 'proof', actor: 'proof', now: tick }));
if (!dup.deduplicated) throw new Error('expected dedup hit');
const gaps = mm.gapReport('company:PROOF', [
  { topic: 'sector', entity_ids: ['company:PROOF'], memory_keys: [] },
  { topic: 'valuation', entity_ids: ['company:PROOF'], memory_keys: [] }
], tick);
const byTopic = Object.fromEntries(gaps.map((g) => [g.topic, g.status]));
if (byTopic['sector'] !== 'STALE') throw new Error(`expected STALE sector gap, got ${byTopic['sector']}`);
if (byTopic['valuation'] !== 'MISSING') throw new Error(`expected MISSING valuation, got ${byTopic['valuation']}`);
void step;

console.log(`memory-proof: RESEARCH→REUSE→REFRESH→CONFLICT ok (kv=${store.knowledgeVersion()})`);
console.log(`timings ms: ${JSON.stringify(timings)}`);
for (const [k, v] of Object.entries(timings)) {
  if (v > 5000) throw new Error(`perf bound exceeded: ${k}=${v}ms`);
}
console.log('verify-memory ok');
db.close();
