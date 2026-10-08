import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SyncManager } from '../src/index.js';
import { commitCompany, makeDevice, prov, sendTo, trustEachOther } from './helpers.js';

/** Shared entity, contradictory content on both sides (Case C). */
function divergedPair() {
  const a = makeDevice('ca');
  const b = makeDevice('cb');
  trustEachOther(a, b);
  commitCompany(a, 'company:X', { ceo: 'A' }, 'OBSERVATION', prov(a, { source_identifier: 'a-src-1' }));
  const seed = sendTo(a, b);
  b.manager.importPackage(b.transport, seed);
  // Independent contradictory updates.
  a.knowledge.proposeValidateCommit({
    assertion: 'OBSERVATION',
    ops: [{ op: 'upsert-node', node: { id: 'company:X', kind: 'Company', label: 'company:X', data: { ceo: 'A2' } } }],
    provenance: prov(a, { source_identifier: 'a-src-2' }),
    actor: 'a'
  });
  b.knowledge.proposeValidateCommit({
    assertion: 'OBSERVATION',
    ops: [{ op: 'upsert-node', node: { id: 'company:X', kind: 'Company', label: 'company:X', data: { ceo: 'B2' } } }],
    provenance: prov(b, { source_identifier: 'b-src-2' }),
    actor: 'b'
  });
  return { a, b };
}

describe('conflicts (Case C)', () => {
  it('contradictory updates become CONFLICT, neither silently overwritten', () => {
    const { a, b } = divergedPair();
    const localBefore = b.knowledge.getEntity('company:X')?.data;
    const file = sendTo(a, b, b.manager.versionVector());
    const r = b.manager.importPackage(b.transport, file);
    expect(r.outcome).toBe('CONFLICT');
    expect(r.conflictIds).toHaveLength(1);
    expect(r.deferred.length).toBeGreaterThan(0);
    // Local state untouched by the merge.
    expect(b.knowledge.getEntity('company:X')?.data).toEqual(localBefore);
    const c = b.manager.getConflict(r.conflictIds[0]!);
    expect(c.entity_ref).toBe('company:X');
    expect(c.status).toBe('UNRESOLVED');
    expect(c.remote_event_ids.length).toBeGreaterThan(0);
    expect(c.provenance_a.length + c.provenance_b.length).toBeGreaterThan(0);
  });

  it('dry-run reports conflicts with zero mutations', () => {
    const { a, b } = divergedPair();
    const file = sendTo(a, b, b.manager.versionVector());
    const snap = b.knowledge.snapshotCanonical();
    const inspected = b.manager.inspectFileContent(file, b.transport.readIncoming(file));
    const report = b.manager.dryRun(inspected);
    expect(report.conflicts).toHaveLength(1);
    expect(report.updatedEntities).toContain('company:X');
    expect(b.knowledge.snapshotCanonical()).toBe(snap);
  });

  it('ACCEPT_A keeps local, remote stays deferred and recorded', () => {
    const { a, b } = divergedPair();
    const file = sendTo(a, b, b.manager.versionVector());
    const r = b.manager.importPackage(b.transport, file);
    const resolved = b.manager.resolveConflict(r.conflictIds[0]!, 'ACCEPT_A', 'operator');
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolution).toBe('ACCEPT_A');
    expect(resolved.resolution_event_id).not.toBeNull();
    expect(b.knowledge.getEntity('company:X')?.data).toEqual({ ceo: 'B2' });
    // Double resolution is refused.
    expect(() => b.manager.resolveConflict(r.conflictIds[0]!, 'ACCEPT_B', 'operator')).toThrow(/ALREADY_RESOLVED/);
  });

  it('ACCEPT_B applies the remote version (history shows both)', () => {
    const { a, b } = divergedPair();
    const file = sendTo(a, b, b.manager.versionVector());
    const r = b.manager.importPackage(b.transport, file);
    b.manager.resolveConflict(r.conflictIds[0]!, 'ACCEPT_B', 'operator');
    expect(b.knowledge.getEntity('company:X')?.data).toEqual({ ceo: 'A2' });
    const hist = b.knowledge.entityHistory('company:X').map((h) => JSON.parse(String(h['data_json'])));
    expect(hist).toContainEqual({ ceo: 'B2' });
    expect(hist).toContainEqual({ ceo: 'A2' });
  });

  it('KEEP_BOTH applies remote as a new version with both preserved', () => {
    const { a, b } = divergedPair();
    const file = sendTo(a, b, b.manager.versionVector());
    const r = b.manager.importPackage(b.transport, file);
    const resolved = b.manager.resolveConflict(r.conflictIds[0]!, 'KEEP_BOTH', 'operator');
    expect(resolved.resolution).toBe('KEEP_BOTH');
    const hist = b.knowledge.entityHistory('company:X');
    expect(hist.length).toBeGreaterThanOrEqual(3); // seed + local + remote
  });

  it('MERGE commits combined content referencing both sides', () => {
    const { a, b } = divergedPair();
    const file = sendTo(a, b, b.manager.versionVector());
    const r = b.manager.importPackage(b.transport, file);
    b.manager.resolveConflict(r.conflictIds[0]!, 'MERGE', 'operator', { data: { ceo: 'A2/B2-interim' } });
    expect(b.knowledge.getEntity('company:X')?.data).toEqual({ ceo: 'A2/B2-interim' });
  });

  it('REJECT_BOTH applies nothing, records the decision', () => {
    const { a, b } = divergedPair();
    const file = sendTo(a, b, b.manager.versionVector());
    const r = b.manager.importPackage(b.transport, file);
    const before = b.knowledge.getEntity('company:X')?.data;
    const resolved = b.manager.resolveConflict(r.conflictIds[0]!, 'REJECT_BOTH', 'operator');
    expect(resolved.resolution).toBe('REJECT_BOTH');
    expect(b.knowledge.getEntity('company:X')?.data).toEqual(before);
  });

  it('resolutions survive restart: re-import stays resolved with zero mutations', () => {
    const { a, b } = divergedPair();
    const file = sendTo(a, b, b.manager.versionVector());
    const bytes = readFileSync(join(b.transport.incomingDir(), file), 'utf8');
    const r = b.manager.importPackage(b.transport, file);
    b.manager.resolveConflict(r.conflictIds[0]!, 'ACCEPT_A', 'operator');
    // Simulate restart: fresh manager over the same knowledge, tables and sync dir.
    const fresh = new SyncManager({ knowledge: b.knowledge, tables: b.tables, syncDir: join(b.dir, 'sync') });
    fresh.addTrust(a.manager.exportPublicTrust());
    writeFileSync(join(b.transport.incomingDir(), file), bytes);
    const snap = b.knowledge.snapshotCanonical();
    const r2 = fresh.importPackage(b.transport, file);
    expect(r2.applied).toHaveLength(0);
    expect(b.knowledge.snapshotCanonical()).toBe(snap);
    expect(fresh.listConflicts('RESOLVED')).toHaveLength(1);
  });
});
