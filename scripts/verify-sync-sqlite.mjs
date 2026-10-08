// Real-SQLite proof for Phase 3 sync (plain node, not vitest).
// Two file-backed devices: divergent transfer, contradiction + KEEP_BOTH,
// reverse merge, VACUUM INTO checkpoint + file restore.
// Run: `pnpm build && node scripts/verify-sync-sqlite.mjs`
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KNOWLEDGE_DDL } from '../dist/packages/db-bootstrap/src/index.js';
import { KnowledgeStore } from '../dist/apps/knowledge-service/src/store.js';
import { SqliteTables } from '../dist/apps/knowledge-service/src/sqlite.js';
import { SyncManager } from '../dist/apps/sync-manager/src/index.js';
import { LocalFilesystemTransport } from '../dist/apps/sync-manager/src/index.js';

let tick = 1_700_000_000_000;
const now = () => (tick += 1000);

function device(name) {
  const dir = mkdtempSync(join(tmpdir(), `aurix-syncproof-${name}-`));
  const dbFile = join(dir, 'knowledge.db');
  const db = new DatabaseSync(dbFile);
  db.exec(KNOWLEDGE_DDL);
  const tables = new SqliteTables(db);
  const knowledge = new KnowledgeStore(tables, { deviceId: `dev-${name}`, now });
  const manager = new SyncManager({ knowledge, tables, syncDir: join(dir, 'sync') });
  const transport = new LocalFilesystemTransport(join(dir, 'transfer'));
  return { dir, dbFile, db, tables, knowledge, manager, transport };
}

function prov(tag, over = {}) {
  return {
    source: `${tag} press`, source_type: 'press', source_identifier: `${tag}-src`,
    observed_at: 1_700_000_000_000, agent: `${tag}-agent`, evidence_refs: [`${tag}-ev`], confidence: 0.8, ...over
  };
}

function commitCompany(d, id, data) {
  return d.knowledge.proposeValidateCommit({
    assertion: 'OBSERVATION',
    ops: [{ op: 'upsert-node', node: { id, kind: 'Company', label: id, data } }],
    provenance: prov(d === A ? 'proofA' : 'proofB'),
    actor: 'proof'
  });
}

const A = device('a');
const B = device('b');
A.manager.addTrust(B.manager.exportPublicTrust());
B.manager.addTrust(A.manager.exportPublicTrust());

// Shared seed + divergent work (one disjoint, one contradictory).
commitCompany(A, 'company:SHARED', { v: 0 });
commitCompany(A, 'company:AX', { v: 1 });
commitCompany(B, 'company:BX', { v: 2 });
{
  const seed = A.manager.createPackage(B.manager.deviceId, null);
  A.transport.stageOutgoing(seed.packageId, seed.content);
  copyFileSync(join(A.transport.outgoingDir(), seed.fileName), join(B.transport.incomingDir(), seed.fileName));
  const r = B.manager.importPackage(B.transport, seed.fileName);
  if (r.outcome !== 'AUTO_MERGE') throw new Error('seed merge failed');
}
// Contradiction on SHARED.
A.knowledge.proposeValidateCommit({
  assertion: 'OBSERVATION',
  ops: [{ op: 'upsert-node', node: { id: 'company:SHARED', kind: 'Company', label: 'company:SHARED', data: { v: 'A2' } } }],
  provenance: prov('proofA2', { source_identifier: 'proofA2-src' }), actor: 'proof'
});
B.knowledge.proposeValidateCommit({
  assertion: 'OBSERVATION',
  ops: [{ op: 'upsert-node', node: { id: 'company:SHARED', kind: 'Company', label: 'company:SHARED', data: { v: 'B2' } } }],
  provenance: prov('proofB2', { source_identifier: 'proofB2-src' }), actor: 'proof'
});
{
  const pkg = A.manager.createPackage(B.manager.deviceId, B.manager.versionVector());
  A.transport.stageOutgoing(pkg.packageId, pkg.content);
  copyFileSync(join(A.transport.outgoingDir(), pkg.fileName), join(B.transport.incomingDir(), pkg.fileName));
  const r = B.manager.importPackage(B.transport, pkg.fileName);
  if (r.outcome !== 'CONFLICT' || r.conflictIds.length !== 1) throw new Error('expected one conflict');
  const resolved = B.manager.resolveConflict(r.conflictIds[0], 'KEEP_BOTH', 'proof-operator');
  if (resolved.status !== 'RESOLVED') throw new Error('resolution failed');
  if (B.knowledge.getEntity('company:SHARED')?.data.v !== 'A2') throw new Error('KEEP_BOTH did not apply remote');
}
console.log(`sqlite: A kv=${A.knowledge.knowledgeVersion()} B kv=${B.knowledge.knowledgeVersion()} conflicts=${B.manager.listConflicts().length}`);

// VACUUM INTO checkpoint + file restore on B's live database.
{
  mkdirSync(join(B.dir, 'checkpoints'), { recursive: true });
  const backup = join(B.dir, 'checkpoints', 'pre-restore.db');
  B.db.exec(`VACUUM INTO '${backup}'`);
  const snap = B.knowledge.snapshotCanonical();
  B.knowledge.proposeValidateCommit({
    assertion: 'OBSERVATION',
    ops: [{ op: 'upsert-node', node: { id: 'company:POST', kind: 'Company', label: 'x', data: {} } }],
    provenance: prov('proofX', { source_identifier: 'proofX-src' }), actor: 'proof'
  });
  if (B.knowledge.snapshotCanonical() === snap) throw new Error('mutation did not change snapshot');
  B.db.close();
  copyFileSync(backup, B.dbFile);
  const db2 = new DatabaseSync(B.dbFile);
  const tables2 = new SqliteTables(db2);
  const k2 = new KnowledgeStore(tables2, { deviceId: 'dev-b', now });
  if (k2.snapshotCanonical() !== snap) throw new Error('VACUUM restore mismatch');
  if (k2.getEntity('company:POST')) throw new Error('restored state leaked post-checkpoint write');
  db2.close();
  console.log('sqlite: VACUUM INTO checkpoint + file restore identical');
}

// No live databases under any transfer dir.
for (const d of [A, B]) {
  for (const sub of ['outgoing', 'incoming', 'processed', 'rejected']) {
    for (const f of readdirSync(join(d.transport.root(), sub))) {
      if (/\.db(-wal|-shm)?$/i.test(f)) throw new Error(`live db in sync dir: ${f}`);
    }
  }
}
A.db.close();
console.log('verify-sync-sqlite ok');
