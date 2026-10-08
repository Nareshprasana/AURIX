import { describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { SyncManager, SyncthingTransport } from '../src/index.js';
import { commitCompany, makeDevice, sendTo, trustEachOther, type TestDevice } from './helpers.js';

describe('interrupted import and recovery', () => {
  function pairWithWork(n = 6) {
    const a = makeDevice('r1a');
    const b = makeDevice('r1b');
    trustEachOther(a, b);
    for (let i = 0; i < n; i++) commitCompany(a, `company:W${i}`, { i });
    return { a, b };
  }

  it('failed import rolls back to a byte-identical state', () => {
    const { a, b } = pairWithWork();
    const file = sendTo(a, b);
    const snap = b.knowledge.snapshotCanonical();
    const hook = { count: 0 };
    const r = importWithCrash(a, b, file, hook);
    expect(r.outcome).toBe('REJECT');
    expect(r.reason).toMatch(/simulated crash/);
    expect(b.knowledge.snapshotCanonical()).toBe(snap);
    expect(hook.count).toBe(1);
    expect(b.manager.listConflicts()).toHaveLength(0);
  });

  it('resume from partial state completes without duplicates', () => {
    const { a, b } = pairWithWork(4);
    const file = sendTo(a, b);
    const inspected = b.manager.inspectFileContent(file, b.transport.readIncoming(file));
    // Simulate a crash after 2 of 4 events: apply a prefix directly (as a crash would leave it).
    const prefix = inspected.inner.events.slice(0, 2);
    b.knowledge.replay(prefix);
    expect(b.knowledge.knowledgeVersion()).toBe(2);
    // Resume via normal import: completes, no duplicates.
    const r = b.manager.importPackage(b.transport, file);
    expect(r.outcome).toBe('AUTO_MERGE');
    expect(r.applied).toHaveLength(2);
    expect(b.knowledge.knowledgeVersion()).toBe(4);
    expect(b.knowledge.snapshotCanonical()).toBe(a.knowledge.snapshotCanonical());
  });

  it('checkpoint primitives restore byte-identical state', () => {
    const { b } = pairWithWork(0);
    commitCompany(b, 'company:K1', { v: 1 });
    commitCompany(b, 'company:K2', { v: 2 });
    const cp = b.manager.checkpoint();
    const snap = b.knowledge.snapshotCanonical();
    commitCompany(b, 'company:LOCAL', { v: 3 });
    expect(b.knowledge.getEntity('company:LOCAL')).toBeDefined();
    b.manager.rollback(cp);
    expect(b.knowledge.getEntity('company:LOCAL')).toBeUndefined();
    expect(b.knowledge.knowledgeVersion()).toBe(2);
    expect(b.knowledge.snapshotCanonical()).toBe(snap);
  });
});

function importWithCrash(a: TestDevice, b: TestDevice, file: string, hook: { count: number }) {
  // Fresh manager sharing B's knowledge/tables so the crash hook can fire,
  // with the same sync dir (same device identity) and sender trust.
  const crashing = new SyncManager({
    knowledge: b.knowledge,
    tables: b.tables,
    syncDir: join(b.dir, 'sync'),
    onBeforeApply: () => {
      hook.count += 1;
      throw new Error('simulated crash');
    }
  });
  crashing.addTrust(a.manager.exportPublicTrust());
  return crashing.importPackage(b.transport, file);
}

describe('identity and store identity', () => {
  it('identity is stable across restarts and carries no host facts', () => {
    const a = makeDevice('id1');
    const id1 = a.manager.deviceId;
    const inst1 = a.manager.installationId;
    const fresh = new SyncManager({ knowledge: a.knowledge, tables: a.tables, syncDir: join(a.dir, 'sync') });
    expect(fresh.deviceId).toBe(id1);
    expect(fresh.installationId).toBe(inst1);
    const raw = readFileSync(join(a.dir, 'sync', 'identity.json'), 'utf8');
    expect(raw).not.toContain(hostname());
    expect(raw).toMatch(/"identity_version": 1/);
    const other = makeDevice('id1b');
    expect(other.manager.deviceId).not.toBe(id1);
  });

  it('store ids are independent of devices (clone gets a new store)', () => {
    const a = makeDevice('id2');
    const b = makeDevice('id2b');
    expect(a.manager.knowledgeStoreId).not.toBe(b.manager.knowledgeStoreId);
    expect(a.manager.knowledgeStoreId).toMatch(/^ks-/);
  });
});

describe('transfer hygiene and integration', () => {
  it('no database files ever appear under sync roots', () => {
    const a = makeDevice('h1a');
    const b = makeDevice('h1b');
    trustEachOther(a, b);
    commitCompany(a, 'company:H', { v: 1 });
    const file = sendTo(a, b);
    b.manager.importPackage(b.transport, file);
    for (const t of [a.transport, b.transport]) {
      for (const d of [t.outgoingDir(), t.incomingDir(), t.processedDir(), t.rejectedDir()]) {
        for (const f of readdirSync(d)) {
          expect(f).not.toMatch(/\.db(-wal|-shm)?$/i);
        }
      }
    }
  });

  it('audit log records the transfer lifecycle without secrets', () => {
    const a = makeDevice('au1a');
    const b = makeDevice('au1b');
    trustEachOther(a, b);
    commitCompany(a, 'company:AUD', { v: 1 });
    const file = sendTo(a, b);
    b.manager.importPackage(b.transport, file);
    const log = readFileSync(join(b.dir, 'sync', 'audit.log'), 'utf8');
    expect(log).toMatch(/import\.started/);
    expect(log).toMatch(/merge\.completed/);
    expect(log).not.toMatch(/PRIVATE KEY/);
    expect(log).not.toMatch(/api_key/);
  });

  it('end-to-end through a Syncthing-style shared folder', () => {
    const a = makeDevice('e2ea');
    const b = makeDevice('e2eb');
    trustEachOther(a, b);
    commitCompany(a, 'company:E2E', { sector: 'IT' });
    // Device A stages into the shared Syncthing folder replica.
    const shared = new SyncthingTransport(join(a.dir, 'shared-replica'));
    const pkg = a.manager.createPackage(b.manager.deviceId, null);
    const stagedPath = join(shared.outgoingDir(), pkg.fileName);
    writeFileSync(stagedPath, pkg.content);
    expect(shared.assertNoLiveDb()).toEqual([]);
    // Syncthing replicates the file; B picks it up from its own incoming.
    copyFileSync(stagedPath, join(b.transport.incomingDir(), pkg.fileName));
    const discovered = b.manager.discover(b.transport);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.status).toBe('READY');
    const inspected = b.manager.inspectFileContent(pkg.fileName, b.transport.readIncoming(pkg.fileName));
    const dry = b.manager.dryRun(inspected);
    expect(dry.newEvents).toHaveLength(1);
    const r = b.manager.importPackage(b.transport, pkg.fileName);
    expect(r.outcome).toBe('AUTO_MERGE');
    expect(b.knowledge.getEntity('company:E2E')?.data).toEqual({ sector: 'IT' });
    expect(existsSync(join(b.transport.processedDir(), pkg.fileName))).toBe(true);
  });
});
