import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitCompany, makeDevice, sendTo, trustEachOther } from './helpers.js';

describe('basic transfer', () => {
  it('A → B merges disjoint knowledge both ways', () => {
    const a = makeDevice('a1');
    const b = makeDevice('b1');
    trustEachOther(a, b);
    commitCompany(a, 'company:AAA', { sector: 'Energy' });
    commitCompany(b, 'company:BBB', { sector: 'Banks' });

    const file = sendTo(a, b);
    const r1 = b.manager.importPackage(b.transport, file);
    expect(r1.outcome).toBe('AUTO_MERGE');
    expect(r1.applied).toHaveLength(1);
    expect(b.knowledge.getEntity('company:AAA')?.data).toEqual({ sector: 'Energy' });

    const back = sendTo(b, a);
    const r2 = a.manager.importPackage(a.transport, back);
    expect(r2.outcome).toBe('AUTO_MERGE');
    expect(a.knowledge.snapshotCanonical()).toBe(b.knowledge.snapshotCanonical());
  });

  it('reverse transfer works symmetrically', () => {
    const a = makeDevice('a2');
    const b = makeDevice('b2');
    trustEachOther(a, b);
    commitCompany(b, 'company:SOLO', { v: 1 });
    const file = sendTo(b, a);
    const r = a.manager.importPackage(a.transport, file);
    expect(r.outcome).toBe('AUTO_MERGE');
    expect(a.knowledge.getEntity('company:SOLO')).toBeDefined();
  });

  it('behind receiver fast-forwards (Case A)', () => {
    const a = makeDevice('a3');
    const b = makeDevice('b3');
    trustEachOther(a, b);
    for (let i = 0; i < 5; i++) commitCompany(a, `company:A${i}`, { i });
    const file = sendTo(a, b);
    const inspected = b.manager.inspectFileContent(file, b.transport.readIncoming(file));
    expect(b.manager.dryRun(inspected).triage).toBe('BEHIND');
    const r = b.manager.importPackage(b.transport, file);
    expect(r.outcome).toBe('AUTO_MERGE');
    expect(r.applied).toHaveLength(5);
    expect(b.knowledge.knowledgeVersion()).toBe(5);
  });

  it('diverged devices auto-merge disjoint entities (Case B)', () => {
    const a = makeDevice('a4');
    const b = makeDevice('b4');
    trustEachOther(a, b);
    commitCompany(a, 'company:SHARED', { v: 0 });
    const seed = sendTo(a, b);
    b.manager.importPackage(b.transport, seed);
    // Independent work on different entities.
    commitCompany(a, 'company:AX', { v: 1 });
    commitCompany(b, 'company:BX', { v: 2 });
    const file = sendTo(a, b, b.manager.versionVector());
    const inspected = b.manager.inspectFileContent(file, b.transport.readIncoming(file));
    expect(b.manager.dryRun(inspected).triage).toBe('DIVERGED');
    const r = b.manager.importPackage(b.transport, file);
    expect(r.outcome).toBe('AUTO_MERGE');
    expect(b.knowledge.getEntity('company:AX')).toBeDefined();
    expect(b.knowledge.getEntity('company:BX')).toBeDefined();
  });

  it('duplicate transfer is a no-op second import', () => {
    const a = makeDevice('a5');
    const b = makeDevice('b5');
    trustEachOther(a, b);
    commitCompany(a, 'company:DUP', { v: 1 });
    const file = sendTo(a, b);
    const bytes = readFileSync(join(b.transport.incomingDir(), file), 'utf8');
    const r1 = b.manager.importPackage(b.transport, file);
    expect(r1.applied).toHaveLength(1);
    // Sender has nothing new: refuses to mint an empty package.
    expect(() => a.manager.createPackage(b.manager.deviceId, b.manager.versionVector())).toThrow(/NOTHING_TO_SYNC/);
    // Syncthing redelivers the same bytes: second import mutates nothing.
    writeFileSync(join(b.transport.incomingDir(), file), bytes);
    const snap = b.knowledge.snapshotCanonical();
    const r2 = b.manager.importPackage(b.transport, file);
    expect(r2.applied).toHaveLength(0);
    expect(r2.deferred).toHaveLength(0);
    expect(b.knowledge.snapshotCanonical()).toBe(snap);
  });

  it('same event through different packages is idempotent', () => {
    const a = makeDevice('a6');
    const b = makeDevice('b6');
    trustEachOther(a, b);
    commitCompany(a, 'company:MULTI', { v: 1 });
    const full = sendTo(a, b);
    const r1 = b.manager.importPackage(b.transport, full);
    expect(r1.applied).toHaveLength(1);
    // New local work → new package containing the old event plus a new one.
    commitCompany(a, 'company:MULTI2', { v: 2 });
    const second = sendTo(a, b, {});
    const r2 = b.manager.importPackage(b.transport, second);
    expect(r2.applied).toHaveLength(1); // only MULTI2; MULTI skipped as DUPLICATE
    expect(b.knowledge.getEntity('company:MULTI')).toBeDefined();
    expect(b.knowledge.getEntity('company:MULTI2')).toBeDefined();
  });
});
