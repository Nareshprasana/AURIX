import { describe, expect, it, beforeEach } from 'vitest';
import { KnowledgeError, KnowledgeStore, MemoryTables } from '../src/index.js';
import { makeStore, nodeInput, prov, resetFixtures } from './fixtures.js';
import type { KnowledgeProposalInput } from '@aurix/contracts';

describe('validation lifecycle', () => {
  beforeEach(resetFixtures);

  it('PROPOSED → VALIDATED → COMMITTED', () => {
    const store = makeStore();
    const p = store.propose(nodeInput('company:L', { v: 1 }));
    expect(p.state).toBe('PROPOSED');
    const v = store.validate(p.id);
    expect(v.state).toBe('VALIDATED');
    const { event, knowledgeVersion } = store.commit(v.id);
    expect(knowledgeVersion).toBe(1);
    expect(event.prev_version).toBe('kv-0');
    expect(event.new_version).toBe('kv-1');
  });

  it('REJECTED proposals cannot commit', () => {
    const store = makeStore();
    const input = nodeInput('x:1', {});
    (input.ops[0] as { node: { kind: string } }).node.kind = 'Nope';
    const v = store.validate(store.propose(input).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(() => store.commit(v.id)).toThrow(KnowledgeError);
  });

  it('commit without validate throws', () => {
    const store = makeStore();
    const p = store.propose(nodeInput('company:L2', {}));
    expect(() => store.commit(p.id)).toThrow(/NOT_VALIDATED/);
  });

  it('unknown proposal throws', () => {
    const store = makeStore();
    expect(() => store.validate('kp-missing')).toThrow(/UNKNOWN_PROPOSAL/);
    expect(() => store.commit('kp-missing')).toThrow(/UNKNOWN_PROPOSAL/);
  });
});

describe('knowledge events', () => {
  beforeEach(resetFixtures);

  it('every mutation appends an ordered event', () => {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:E1', {}));
    store.proposeValidateCommit(nodeInput('company:E2', {}));
    const events = store.eventsAfter(0);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.new_version)).toEqual(['kv-1', 'kv-2']);
    expect(events[0]?.id).toMatch(/^ke-1-/);
  });

  it('duplicate commit is idempotent (no duplicate knowledge, no version bump)', () => {
    const store = makeStore();
    const p = store.propose(nodeInput('company:IDEM', { v: 1 }));
    store.validate(p.id);
    const first = store.commit(p.id);
    const second = store.commit(p.id);
    expect(second.event.id).toBe(first.event.id);
    expect(store.knowledgeVersion()).toBe(1);
    expect(store.entityHistory('company:IDEM')).toHaveLength(1);
  });

  it('replay rebuilds identical state and version', () => {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:R1', { ceo: 'A' }));
    store.proposeValidateCommit(nodeInput('company:R2', { ceo: 'B' }));
    store.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'put-memory', memory: { category: 'semantic', key: 'sector-map', content: { IT: ['TCS'] } } }],
      provenance: prov(),
      actor: 'test'
    });
    const events = store.eventsAfter(0);
    const rebuilt = new KnowledgeStore(new MemoryTables(), { deviceId: 'dev-other' });
    expect(rebuilt.replay(events)).toBe(store.knowledgeVersion());
    expect(rebuilt.snapshotCanonical()).toBe(store.snapshotCanonical());
    // Replaying the same events again changes nothing.
    expect(rebuilt.replay(events)).toBe(store.knowledgeVersion());
    expect(rebuilt.snapshotCanonical()).toBe(store.snapshotCanonical());
  });

  it('recovery: rebuild from events restores queries', () => {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:REC', { ceo: 'Z' }));
    const rebuilt = new KnowledgeStore(new MemoryTables(), {});
    rebuilt.replay(store.eventsAfter(0));
    expect(rebuilt.getEntity('company:REC')?.data).toEqual({ ceo: 'Z' });
    expect(rebuilt.entityHistory('company:REC')).toHaveLength(1);
  });
});
