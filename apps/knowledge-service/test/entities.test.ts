import { describe, expect, it, beforeEach } from 'vitest';
import { KnowledgeError } from '../src/index.js';
import { makeStore, nodeInput, prov, resetFixtures } from './fixtures.js';

describe('knowledge entities', () => {
  beforeEach(resetFixtures);

  it('creates and reads an entity', () => {
    const store = makeStore();
    const { event } = store.proposeValidateCommit(nodeInput('company:RELIANCE', { sector: 'Energy' }));
    expect(event.entity_ref).toBe('company:RELIANCE');
    const node = store.getEntity('company:RELIANCE');
    expect(node).toMatchObject({ id: 'company:RELIANCE', kind: 'Company', version: 1, status: 'ACTIVE' });
    expect(node?.data).toEqual({ sector: 'Energy' });
    expect(store.knowledgeVersion()).toBe(1);
  });

  it('updates create a new version, preserving history', () => {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:X', { ceo: 'Person A' }));
    store.proposeValidateCommit(nodeInput('company:X', { ceo: 'Person B' }));
    const node = store.getEntity('company:X');
    expect(node?.version).toBe(2);
    expect(node?.data).toEqual({ ceo: 'Person B' });
    const history = store.entityHistory('company:X');
    expect(history.map((h) => JSON.parse(String(h['data_json'])))).toEqual([{ ceo: 'Person A' }, { ceo: 'Person B' }]);
  });

  it('rejects invalid entity kind', () => {
    const store = makeStore();
    const input = nodeInput('x:1', {});
    (input.ops[0] as { node: { kind: string } }).node.kind = 'Spaceship';
    const p = store.propose(input);
    const v = store.validate(p.id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/kind/);
    expect(store.knowledgeVersion()).toBe(0);
  });

  it('rejects duplicate entity (identical content)', () => {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:DUP', { v: 1 }));
    const v = store.validate(store.propose(nodeInput('company:DUP', { v: 1 })).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/DUPLICATE_ENTITY/);
  });

  it('unknown entity read returns undefined', () => {
    expect(makeStore().getEntity('company:NOPE')).toBeUndefined();
  });
});
