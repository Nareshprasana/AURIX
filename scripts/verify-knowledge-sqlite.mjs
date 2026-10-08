// Real-SQLite proof for the Phase 2 knowledge platform (plain node, not vitest).
// Builds the TS sources (tsconfig.build.json), then runs propose → validate →
// commit → query → export → replay-into-memory on REAL node:sqlite tables.
// Run: `pnpm build && node scripts/verify-knowledge-sqlite.mjs`
import { DatabaseSync } from 'node:sqlite';
import { KNOWLEDGE_DDL } from '../dist/packages/db-bootstrap/src/index.js';
import { KnowledgeStore } from '../dist/apps/knowledge-service/src/store.js';
import { MemoryTables } from '../dist/apps/knowledge-service/src/tables.js';
import { SqliteTables } from '../dist/apps/knowledge-service/src/sqlite.js';
import { buildExport, verifyExport } from '../dist/apps/knowledge-service/src/export.js';

let tick = 1_700_000_000_000;
const now = () => (tick += 1000);

function prov(sourceId, sourceType = 'press') {
  return {
    source: 'Proof Press', source_type: sourceType, source_identifier: sourceId,
    observed_at: 1_700_000_000_000, agent: 'proof', evidence_refs: ['ev-proof'], confidence: 0.8
  };
}

const db = new DatabaseSync(':memory:');
db.exec(KNOWLEDGE_DDL);
const store = new KnowledgeStore(new SqliteTables(db), { deviceId: 'dev-proof', now });

const c1 = store.proposeValidateCommit({
  assertion: 'OBSERVATION',
  ops: [{ op: 'upsert-node', node: { id: 'company:PROOF', kind: 'Company', label: 'Proof Co', data: { ceo: 'A' } } }],
  provenance: prov('proof-1'),
  actor: 'proof'
});
store.proposeValidateCommit({
  assertion: 'OBSERVATION',
  ops: [{ op: 'upsert-node', node: { id: 'company:PROOF', kind: 'Company', label: 'Proof Co', data: { ceo: 'B' } } }],
  provenance: prov('proof-2'),
  actor: 'proof'
});
store.proposeValidateCommit({
  assertion: 'OBSERVATION',
  ops: [
    { op: 'upsert-node', node: { id: 'observation:thesis', kind: 'Observation', label: 'thesis', data: { text: 'bullish' } } },
    { op: 'add-edge', edge: { src: 'company:PROOF', dst: 'observation:thesis', rel: 'SUPPORTED_BY', confidence: 0.7 } }
  ],
  provenance: prov('proof-3'),
  actor: 'proof'
});
store.proposeValidateCommit({
  assertion: 'OBSERVATION',
  ops: [{ op: 'put-memory', memory: { category: 'semantic', key: 'm1', content: { fact: 'x' } } }],
  provenance: prov('proof-4'),
  actor: 'proof'
});

if (store.getEntity('company:PROOF')?.version !== 2) throw new Error('expected entity v2');
if (store.entityHistory('company:PROOF').length !== 2) throw new Error('expected 2 history rows');
if (store.getEdges('observation:thesis', { direction: 'in' }).length !== 1) throw new Error('expected 1 edge');
if (store.supportingEvidence('observation:thesis').length < 1) throw new Error('expected supporting evidence');
if (store.knowledgeVersion() !== 4) throw new Error(`expected kv 4, got ${store.knowledgeVersion()}`);

const pkg = buildExport(store, { now: 1_700_000_000_000 });
if (verifyExport(pkg).length > 0) throw new Error('export verify failed');
console.log(`sqlite: commits ok, kv=${store.knowledgeVersion()}, export events=${pkg.manifest.event_count}`);

// Replay the real-SQLite events into a memory store: identical snapshot.
const rebuilt = new KnowledgeStore(new MemoryTables(), { deviceId: 'dev-replay' });
rebuilt.replay(store.eventsAfter(0));
if (rebuilt.snapshotCanonical() !== store.snapshotCanonical()) throw new Error('replay snapshot mismatch');
if (rebuilt.knowledgeVersion() !== store.knowledgeVersion()) throw new Error('replay version mismatch');
console.log('sqlite: replay into memory store identical');
console.log(`sqlite: first event entity=${c1.event.entity_ref} label=${c1.event.label_class}`);
db.close();
console.log('verify-knowledge-sqlite ok');
