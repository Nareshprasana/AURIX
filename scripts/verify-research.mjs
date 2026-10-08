// Phase 5 proof on real SQLite (plain node, not vitest).
// Demonstrates the §38 loop: request → RESEARCH → agents → evidence → knowledge
// → memory → REUSE; event → scoped REFRESH; quarantine blocks VALID-claims;
// research ↛ broker/risk/execution (import scan).
// Run: `pnpm build && node scripts/verify-research.mjs`
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { KNOWLEDGE_DDL } from '../dist/packages/db-bootstrap/src/index.js';
import { KnowledgeStore } from '../dist/apps/knowledge-service/src/store.js';
import { SqliteTables } from '../dist/apps/knowledge-service/src/sqlite.js';
import { MemoryManager } from '../dist/apps/memory-manager/src/index.js';
import { normalizeBar, assessBar, earningsEvent } from '../dist/packages/market-data/src/index.js';
import { ResearchOrchestrator } from '../dist/apps/research-agents/src/index.js';

let tick = 1_900_000_000_000;
const now = () => tick;

const db = new DatabaseSync(':memory:');
db.exec(KNOWLEDGE_DDL);
const store = new KnowledgeStore(new SqliteTables(db), { deviceId: 'dev-proof', now });
const memory = new MemoryManager(store);
const orch = new ResearchOrchestrator(store, memory);
const timings = {};
function timed(name, fn) {
  const t0 = Date.now();
  const out = fn();
  const v = out && typeof out.then === 'function' ? out.then((r) => { timings[name] = Date.now() - t0; return r; }) : out;
  if (v === out) timings[name] = Date.now() - t0;
  return v;
}

function metricEv(metric, value, period, id) {
  return {
    evidence_id: `ev-${id}`, kind: 'financial-metric', subject: 'company:PROOF',
    content: { metric, value, period }, source: 'filing-fixture', source_type: 'press',
    source_identifier: `filing-${id}`, observed_at: tick, retrieved_at: tick, confidence: 0.85
  };
}

const fundEvidence = [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')];

// 1. First request → RESEARCH with agents, evidence, committed knowledge.
const r1 = await timed('research', () => orch.investigate({
  subject: 'company:PROOF', objective: 'fundamental growth analysis',
  agent: 'proof', actor: 'proof', evidence: fundEvidence, now: tick
}));
if (r1.path !== 'RESEARCH') throw new Error(`expected RESEARCH, got ${r1.path}`);
if (!r1.agentsRun.includes('fundamental')) throw new Error('fundamental agent did not run');
if (!r1.bundle || r1.bundle.knowledge_refs.length === 0) throw new Error('nothing committed');

// 2. Second identical request → REUSE, no agent rerun.
const r2 = await timed('reuse', () => orch.investigate({
  subject: 'company:PROOF', objective: 'fundamental growth analysis',
  agent: 'proof', actor: 'proof', evidence: fundEvidence, now: tick
}));
if (r2.path !== 'REUSE' || r2.agentsRun.length !== 0) throw new Error(`expected REUSE, got ${r2.path}`);
if (r2.bundle?.task_id !== r1.bundle?.task_id) throw new Error('REUSE returned a different bundle');

// 3. New earnings event → scoped REFRESH of the dependent research only.
const ev = earningsEvent(['PROOF'], tick, tick, 'exchange');
ev.entity_refs = ['company:PROOF'];
const affected = orch.affectedTasks(ev);
if (affected.length !== 1) throw new Error(`expected 1 affected task, got ${affected.length}`);
const res = await timed('event-refresh', () => orch.refreshForEvent(ev, 'proof', tick));
if (res.refreshed.length !== 1 || res.refreshed[0].outcome.path !== 'REFRESH') {
  throw new Error('event did not trigger scoped REFRESH');
}

// 4. Quarantined bars can never become VALID observations.
const bad = normalizeBar({
  instrument_id: 'PROOF', exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: 'PROOF',
  ts: tick, tz: 'Asia/Kolkata', timeframe: '1D', open: 1, high: 2, low: 1, close: -5, volume: 10
}, 'stub');
const badReport = assessBar(bad, { now: tick });
if (badReport.verdict !== 'QUARANTINED') throw new Error('bad bar must quarantine');
const rBad = await orch.investigate({
  subject: 'company:PROOF', objective: 'price trend analysis', agent: 'proof', actor: 'proof',
  bars: [bad], now: tick
});
if (rBad.bundle?.status !== 'DATA_QUARANTINED') throw new Error(`expected DATA_QUARANTINED, got ${rBad.bundle?.status}`);
if ((rBad.bundle?.observations.length ?? 1) !== 0) throw new Error('quarantined data produced observations');

// 5. Research ↛ broker/risk/execution (static import scan of built sources).
const walk = (dir, out = []) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`;
    if (f.isDirectory()) walk(p, out);
    else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
};
for (const f of walk('apps/research-agents/src')) {
  const src = readFileSync(f, 'utf8');
  if (/@aurix\/(broker|execution|risk|portfolio|model-gateway)/.test(src) || /\bplaceOrder\b|BrokerPort|kiteconnect/.test(src)) {
    throw new Error(`forbidden import in ${f}`);
  }
}

console.log(`research-proof: RESEARCH→REUSE→REFRESH→QUARANTINE-BLOCK ok (kv=${store.knowledgeVersion()})`);
console.log(`timings ms: ${JSON.stringify(timings)}`);
console.log('verify-research ok');
db.close();
