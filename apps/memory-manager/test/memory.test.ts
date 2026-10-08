import { describe, expect, it, beforeEach } from 'vitest';
import { advance, commitMemory, commitNode, makeManager, NOW, prov, resetHelpers } from './helpers.js';

describe('memory retrieval', () => {
  beforeEach(resetHelpers);

  it('stores and retrieves by entity', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'sector:tcs', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.9 });
    const hits = manager.retrieve({ entity: 'company:TCS' }, NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.relevance.heuristic).toBe(true);
    expect(hits[0]?.relevance.matched_on).toContain('entity');
  });

  it('filters by topic, labels, confidence and time range', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'a', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.9 });
    commitMemory(store, 'semantic', 'b', { entity: 'company:TCS', topic: 'valuation', domain: 'fundamentals', confidence: 0.4 });
    commitNode(store, 'company:TCS', { entity: 'company:TCS', topic: 'sector', domain: 'static' }, 'FACT', prov({ source_type: 'exchange-filing' }));
    expect(manager.retrieve({ entity: 'company:TCS', topic: 'sector' }, NOW)).toHaveLength(2);
    expect(manager.retrieve({ entity: 'company:TCS', minConfidence: 0.8 }, NOW)).toHaveLength(1);
    expect(manager.retrieve({ entity: 'company:TCS', labels: ['FACT'] }, NOW)).toHaveLength(1);
    advance(60_000);
    expect(manager.retrieve({ entity: 'company:TCS', fromTs: NOW + 1 }, NOW + 60_000)).toHaveLength(0);
  });

  it('exposes why each memory matched (no black box)', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'a', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.9 });
    const [hit] = manager.retrieve({ entity: 'company:TCS', topic: 'sector' }, NOW);
    expect(hit?.relevance.score).toBeGreaterThan(0.5);
    expect(hit?.relevance.matched_on).toEqual(expect.arrayContaining(['entity', 'topic']));
    expect(hit?.kind).toBe('memory');
  });

  it('classifies freshness per domain (price fast, static slow)', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'p', { entity: 'company:TCS', topic: 'price', domain: 'price', confidence: 0.9 });
    commitMemory(store, 'semantic', 's', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.9 });
    const t = NOW + 10 * 60_000; // +10 min
    const price = manager.retrieve({ entity: 'company:TCS', topic: 'price' }, t)[0]!;
    const stat = manager.retrieve({ entity: 'company:TCS', topic: 'sector' }, t)[0]!;
    expect(manager.freshnessOf(price, t)).toBe('STALE');
    expect(manager.freshnessOf(stat, t)).toBe('FRESH');
  });

  it('never invents confidence for nodes; minConfidence excludes unknowns', () => {
    const { store, manager } = makeManager();
    commitNode(store, 'company:TCS', { entity: 'company:TCS', topic: 'sector', domain: 'static' });
    const [hit] = manager.retrieve({ entity: 'company:TCS' }, NOW);
    expect(hit?.confidence).toBeNull();
    expect(manager.retrieve({ entity: 'company:TCS', minConfidence: 0.1 }, NOW)).toHaveLength(0);
  });

  it('keeps provenance answerable for retrieved records', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'evidence', 'filing', { entity: 'company:TCS', topic: 'filing', domain: 'fundamentals', confidence: 0.95 }, 'OBSERVATION', prov({ source: 'Exchange disclosure', evidence_refs: ['filing-42'] }));
    commitNode(store, 'company:TCS', { entity: 'company:TCS', topic: 'filing', domain: 'fundamentals' });
    const hits = manager.retrieve({ entity: 'company:TCS' }, NOW);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const chain = store.provenanceChain('company:TCS');
    expect(chain.length).toBeGreaterThanOrEqual(1);
    const filingChain = store.provenanceChain('evidence:filing');
    expect(filingChain[0]?.['source']).toBe('Exchange disclosure');
    expect(String(filingChain[0]?.['evidence_refs_json'])).toMatch(/filing-42/);
  });

  it('records carry validation state distinctly from freshness', () => {
    const { store, manager } = makeManager();
    commitNode(store, 'company:OLD', { entity: 'company:OLD', topic: 'sector', domain: 'static' }, 'FACT', prov({ source_type: 'exchange-filing' }));
    const t = NOW + 800 * 24 * 3600_000; // +800d: stale by age, still FACT
    const [hit] = manager.retrieve({ entity: 'company:OLD' }, t);
    expect(hit?.validation).toBe('validated');
    expect(hit?.label).toBe('FACT');
    expect(manager.freshnessOf(hit!, t)).toBe('STALE');
  });
});
