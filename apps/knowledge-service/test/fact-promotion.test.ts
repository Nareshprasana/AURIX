import { describe, expect, it, beforeEach } from 'vitest';
import { makeStore, nodeInput, prov, resetFixtures } from './fixtures.js';

describe('FACT promotion policy', () => {
  beforeEach(resetFixtures);

  it('single unsupported LLM FACT claim is NOT FACT (downgraded to INFERENCE)', () => {
    const store = makeStore();
    const { event } = store.proposeValidateCommit(
      nodeInput('company:LLM', { ceo: 'Robot' }, 'FACT', prov({ source_type: 'llm', model: 'stub-a', prompt_version: 'v1' }))
    );
    expect(event.label_class).toBe('INFERENCE');
    expect(store.getEntity('company:LLM')?.label_class).toBe('INFERENCE');
  });

  it('single non-authoritative FACT claim is REJECTED pending corroboration', () => {
    const store = makeStore();
    const v = store.validate(store.propose(nodeInput('company:C1', { ceo: 'A' }, 'FACT', prov({ source_identifier: 'press-1' }))).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/NEEDS_CORROBORATION/);
    expect(store.getEntity('company:C1')).toBeUndefined();
  });

  it('corroborated FACT (two independent sources) commits as FACT', () => {
    const store = makeStore();
    const data = { ceo: 'A' };
    const first = store.validate(store.propose(nodeInput('company:C2', data, 'FACT', prov({ source_identifier: 'press-1', evidence_refs: ['ev-a'] }))).id);
    expect(first.state).toBe('REJECTED');
    const { event } = store.proposeValidateCommit(nodeInput('company:C2', data, 'FACT', prov({ source_identifier: 'press-2', evidence_refs: ['ev-b'] })));
    expect(event.label_class).toBe('FACT');
    expect(store.getEntity('company:C2')).toMatchObject({ label_class: 'FACT', version: 1 });
  });

  it('authoritative source establishes FACT alone', () => {
    const store = makeStore();
    const { event } = store.proposeValidateCommit(
      nodeInput('company:C3', { ceo: 'B' }, 'FACT', prov({ source_type: 'exchange-filing', source_identifier: 'filing-1' }))
    );
    expect(event.label_class).toBe('FACT');
    expect(store.getEntity('company:C3')?.label_class).toBe('FACT');
  });

  it('same source twice does not corroborate itself', () => {
    const store = makeStore();
    const data = { ceo: 'C' };
    store.validate(store.propose(nodeInput('company:C4', data, 'FACT', prov({ source_identifier: 'press-same' }))).id);
    const v = store.validate(store.propose(nodeInput('company:C4', data, 'FACT', prov({ source_identifier: 'press-same' }))).id);
    expect(v.state).toBe('REJECTED');
  });
});
