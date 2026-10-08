import { describe, expect, it, beforeEach } from 'vitest';
import { makeStore, nodeInput, prov, resetFixtures } from './fixtures.js';
import type { KnowledgeProposalInput } from '@aurix/contracts';

function edgeInput(src: string, dst: string, rel: 'SUPPORTED_BY' | 'CONTRADICTED_BY' | 'AFFECTS' = 'AFFECTS'): KnowledgeProposalInput {
  return {
    assertion: 'OBSERVATION',
    ops: [{ op: 'add-edge', edge: { src, dst, rel, confidence: 0.7 } }],
    provenance: prov(),
    actor: 'test'
  };
}

describe('knowledge relationships', () => {
  beforeEach(resetFixtures);

  function seeded() {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:A', { sector: 'Energy' }));
    store.proposeValidateCommit(nodeInput('company:B', { sector: 'Banks' }));
    return store;
  }

  it('creates and queries a relationship', () => {
    const store = seeded();
    store.proposeValidateCommit(edgeInput('company:A', 'company:B', 'AFFECTS'));
    const edges = store.getEdges('company:A', { direction: 'out' });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src: 'company:A', dst: 'company:B', rel: 'AFFECTS', status: 'ACTIVE', version: 1 });
    expect(store.neighbors('company:A', 'AFFECTS')).toEqual(['company:B']);
  });

  it('rejects invalid relationship type', () => {
    const store = seeded();
    const input = edgeInput('company:A', 'company:B');
    (input.ops[0] as { edge: { rel: string } }).edge.rel = 'LIKES';
    const v = store.validate(store.propose(input).id);
    expect(v.state).toBe('REJECTED');
  });

  it('rejects unknown endpoints', () => {
    const store = seeded();
    const v = store.validate(store.propose(edgeInput('company:A', 'company:GHOST')).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/UNKNOWN_ENDPOINT/);
  });

  it('rejects duplicate relationship', () => {
    const store = seeded();
    store.proposeValidateCommit(edgeInput('company:A', 'company:B', 'AFFECTS'));
    const v = store.validate(store.propose(edgeInput('company:A', 'company:B', 'AFFECTS')).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/DUPLICATE_EDGE/);
  });

  it('preserves conflicting relationships side-by-side', () => {
    const store = seeded();
    store.proposeValidateCommit(nodeInput('observation:thesis-1', { text: 'bullish' }));
    store.proposeValidateCommit(nodeInput('observation:ev-a', { text: 'strong earnings' }));
    store.proposeValidateCommit(nodeInput('observation:ev-b', { text: 'weak guidance' }));
    store.proposeValidateCommit(edgeInput('observation:ev-a', 'observation:thesis-1', 'SUPPORTED_BY'));
    store.proposeValidateCommit(edgeInput('observation:ev-b', 'observation:thesis-1', 'CONTRADICTED_BY'));
    expect(store.supportingEvidence('observation:thesis-1').length).toBeGreaterThanOrEqual(1);
    // ev-b contributes two provenance rows (node creation + edge commit); both count as contradicting evidence.
    expect(store.contradictingEvidence('observation:thesis-1')).toHaveLength(2);
    // Neither overwrote the other: both edges ACTIVE.
    expect(store.getEdges('observation:thesis-1', { direction: 'in' })).toHaveLength(2);
  });

  it('changing a relationship expires the old version', () => {
    const store = seeded();
    store.proposeValidateCommit(edgeInput('company:A', 'company:B', 'AFFECTS'));
    const input = edgeInput('company:A', 'company:B', 'AFFECTS');
    (input.ops[0] as { edge: { confidence: number } }).edge.confidence = 0.9;
    store.proposeValidateCommit(input);
    const active = store.getEdges('company:A');
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(2);
    expect(active[0]?.confidence).toBeCloseTo(0.9);
    expect(store.getEdges('company:A', { includeExpired: true })).toHaveLength(2);
  });
});
