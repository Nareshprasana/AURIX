import { describe, expect, it, beforeEach } from 'vitest';
import { makeStore, prov, resetFixtures } from './fixtures.js';
import type { KnowledgeProposalInput, MemoryCategory } from '@aurix/contracts';

const CATEGORIES: MemoryCategory[] = ['semantic', 'episodic', 'trading-experience', 'strategy', 'agent', 'evidence'];

function memInput(category: MemoryCategory, key: string, content: Record<string, unknown>): KnowledgeProposalInput {
  return {
    assertion: 'OBSERVATION',
    ops: [{ op: 'put-memory', memory: { category, key, content } }],
    provenance: prov(),
    actor: 'test'
  };
}

describe('memory layers', () => {
  beforeEach(resetFixtures);

  it('stores and queries all six memory categories', () => {
    const store = makeStore();
    for (const category of CATEGORIES) {
      store.proposeValidateCommit(memInput(category, `key-${category}`, { v: category }));
    }
    for (const category of CATEGORIES) {
      const rows = store.queryMemories(category);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toEqual({ v: category });
    }
  });

  it('keeps memory history per key', () => {
    const store = makeStore();
    store.proposeValidateCommit(memInput('agent', 'risk-notes', { n: 1 }));
    store.proposeValidateCommit(memInput('agent', 'risk-notes', { n: 2 }));
    expect(store.queryMemories('agent', 'risk-notes')).toHaveLength(2);
  });

  it('rejects duplicate memory content', () => {
    const store = makeStore();
    store.proposeValidateCommit(memInput('semantic', 'k', { v: 1 }));
    const v = store.validate(store.propose(memInput('semantic', 'k', { v: 1 })).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/DUPLICATE_MEMORY/);
  });
});

describe('embeddings (model-versioned)', () => {
  beforeEach(resetFixtures);

  function embInput(model: string, version: string, vector: number[]): KnowledgeProposalInput {
    return {
      assertion: 'OBSERVATION',
      ops: [{ op: 'put-embedding', embedding: { document_id: 'doc-1', model, model_version: version, vector, source: 'local-test' } }],
      provenance: prov(),
      actor: 'test'
    };
  }

  it('stores versioned embeddings; model change keeps old vectors', () => {
    const store = makeStore();
    store.proposeValidateCommit(embInput('mini', 'v1', [0.1, 0.2]));
    store.proposeValidateCommit(embInput('large', 'v1', [0.1, 0.2, 0.3]));
    const rows = store.getEmbeddings('doc-1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['model'])).toEqual(['mini', 'large']);
  });

  it('rejects empty/non-finite vectors', () => {
    const store = makeStore();
    expect(store.validate(store.propose(embInput('m', 'v1', [])).id).state).toBe('REJECTED');
    expect(store.validate(store.propose(embInput('m', 'v1', [NaN])).id).state).toBe('REJECTED');
  });
});
