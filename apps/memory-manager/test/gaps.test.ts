import { describe, expect, it, beforeEach } from 'vitest';
import { commitMemory, commitNode, makeManager, NOW, prov, resetHelpers } from './helpers.js';
import type { TopicRule } from '../src/index.js';

const RULES: TopicRule[] = [
  { topic: 'sector', entity_ids: ['company:TCS'], memory_keys: [] },
  { topic: 'valuation', entity_ids: ['company:TCS'], memory_keys: [] },
  { topic: 'sentiment', entity_ids: ['company:TCS'], memory_keys: [] }
];

describe('invalidation', () => {
  beforeEach(resetHelpers);

  it('new event marks memories STALE without deleting history', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'rev', { entity: 'company:TCS', topic: 'revenue', domain: 'fundamentals', confidence: 0.9 });
    const before = store.snapshotMemories().length;
    manager.invalidate({ targets: ['company:TCS', 'revenue:company:TCS'], cause: 'earnings', eventRef: 'ev-earn-1', actor: 'tester' });
    expect(store.snapshotMemories().length).toBe(before + 2);
    const markers = manager.markersFor('company:TCS');
    expect(markers).toHaveLength(1);
    expect((markers[0]?.content as { status: string }).status).toBe('STALE');
  });

  it('contradictory evidence marks CONTRADICTED', () => {
    const { manager } = makeManager();
    manager.invalidate({ targets: ['company:TCS'], cause: 'conflicting sources', eventRef: 'ev-x', actor: 'tester', status: 'CONTRADICTED' });
    const d = manager.decide({ subject: 'company:TCS', now: NOW });
    expect(d.decision).toBe('CONFLICT');
  });

  it('data-quality failure invalidates affected records', () => {
    const { store, manager } = makeManager();
    commitNode(store, 'observation:price:X:1', { entity: 'instrument:X', topic: 'price', domain: 'price' });
    manager.invalidate({ targets: ['instrument:X'], cause: 'data-quality failure: stale feed', eventRef: 'dq-1', actor: 'dq-monitor', status: 'INVALIDATED' });
    expect(manager.markersFor('instrument:X')[0]?.content).toMatchObject({ status: 'INVALIDATED' });
    void store;
    void prov;
  });

  it('old research is preserved alongside markers', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'old', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.9 });
    manager.invalidate({ targets: ['company:TCS'], cause: 'refresh cycle', eventRef: 'ev-2', actor: 'tester', status: 'SUPERSEDED' });
    const all = store.snapshotMemories();
    expect(all.some((m) => m.key === 'old')).toBe(true);
    expect(all.some((m) => m.key === 'invalidation:company:TCS')).toBe(true);
  });
});

describe('knowledge gaps', () => {
  beforeEach(resetHelpers);

  it('reports KNOWN / MISSING / STALE / CONFLICTED distinctly', () => {
    const { store, manager } = makeManager();
    commitNode(store, 'company:TCS', { entity: 'company:TCS', topic: 'sector', domain: 'static' }, 'OBSERVATION', prov({ source_type: 'exchange-filing' }));
    commitMemory(store, 'semantic', 'val', { entity: 'company:TCS', topic: 'valuation', domain: 'fundamentals', confidence: 0.8 });
    commitMemory(store, 'semantic', 's1', { entity: 'company:TCS', topic: 'sentiment', domain: 'research', confidence: 0.8, view: 'up' });
    commitMemory(store, 'semantic', 's2', { entity: 'company:TCS', topic: 'sentiment', domain: 'research', confidence: 0.8, view: 'down' });
    const t = NOW + 200 * 24 * 3600_000; // valuation (90/180d) now STALE
    const report = manager.gapReport('company:TCS', RULES, t);
    const byTopic = Object.fromEntries(report.map((g) => [g.topic, g.status]));
    expect(byTopic['sector']).toBe('KNOWN');
    expect(byTopic['valuation']).toBe('STALE');
    expect(byTopic['sentiment']).toBe('CONFLICTED');
  });

  it('budget info exposes effort, evidence and history', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'a', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.9 });
    manager.registerTask({ subject: 'company:TCS', objective: 'valuation', scope: 'now', agent: 'a1', actor: 't', now: NOW });
    const info = manager.budgetInfo('company:TCS', RULES, NOW + 200 * 24 * 3600_000);
    expect(info.evidence_count).toBeGreaterThan(0);
    expect(info.research_history).toHaveLength(1);
    expect(info.estimated_effort).toBeGreaterThanOrEqual(1);
    expect(info.basis).toMatch(/heuristic/);
    expect(info.missing).toContain('valuation');
    void store;
  });
});
