import { describe, expect, it, beforeEach } from 'vitest';
import { makeStore, nodeInput, prov, resetFixtures } from './fixtures.js';

describe('provenance', () => {
  beforeEach(resetFixtures);

  it('requires a source', () => {
    const store = makeStore();
    const v = store.validate(store.propose(nodeInput('company:P', {}, 'OBSERVATION', prov({ source: '' }))).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/source/);
  });

  it('requires observed_at timestamp', () => {
    const store = makeStore();
    const v = store.validate(store.propose(nodeInput('company:P', {}, 'OBSERVATION', prov({ observed_at: 0 }))).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/observed_at/);
  });

  it('requires an agent', () => {
    const store = makeStore();
    const v = store.validate(store.propose(nodeInput('company:P', {}, 'OBSERVATION', prov({ agent: '' }))).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/agent/);
  });

  it('requires evidence refs (except UNKNOWN)', () => {
    const store = makeStore();
    const v = store.validate(store.propose(nodeInput('company:P', {}, 'OBSERVATION', prov({ evidence_refs: [] }))).id);
    expect(v.state).toBe('REJECTED');
    const okUnknown = store.proposeValidateCommit(nodeInput('company:U', {}, 'UNKNOWN', prov({ evidence_refs: [] })));
    expect(okUnknown.knowledgeVersion).toBe(1);
  });

  it('validates confidence range', () => {
    const store = makeStore();
    const v = store.validate(store.propose(nodeInput('company:P', {}, 'OBSERVATION', prov({ confidence: 1.5 }))).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/confidence/);
  });

  it('records validation state and answers provenance questions', () => {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:Q', { sector: 'IT' }, 'OBSERVATION', prov({ source: 'Exchange disclosure', source_type: 'exchange-filing', evidence_refs: ['filing-9'] })));
    const chain = store.provenanceChain('company:Q');
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ source: 'Exchange disclosure', validation_state: 'VALIDATED', agent: 'test-agent' });
    expect(chain[0]?.['evidence_refs_json']).toMatch(/filing-9/);
  });
});
