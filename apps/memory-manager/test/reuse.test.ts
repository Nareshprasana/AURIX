import { describe, expect, it, beforeEach } from 'vitest';
import { advance, commitMemory, commitNode, makeManager, NOW, prov, resetHelpers } from './helpers.js';

function sectorMemory(confidence = 0.9, topic = 'sector') {
  return { entity: 'company:TCS', topic, domain: 'static', confidence };
}

describe('reuse decisions', () => {
  beforeEach(resetHelpers);

  it('fresh validated memory → REUSE', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 's', sectorMemory());
    const d = manager.decide({ subject: 'company:TCS', topic: 'sector', now: NOW });
    expect(d.decision).toBe('REUSE');
    expect(d.basis.join(' ')).toMatch(/REUSE|fresh/i);
  });

  it('stale memory → REFRESH', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'p', { entity: 'company:TCS', topic: 'price', domain: 'price', confidence: 0.9 });
    const d = manager.decide({ subject: 'company:TCS', topic: 'price', now: NOW + 3600_000 });
    expect(d.decision).toBe('REFRESH');
  });

  it('missing memory → RESEARCH', () => {
    const { manager } = makeManager();
    const d = manager.decide({ subject: 'company:GHOST', now: NOW });
    expect(d.decision).toBe('RESEARCH');
  });

  it('contradictory validated records → CONFLICT (no silent overwrite)', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'bull', { entity: 'company:TCS', topic: 'sentiment', domain: 'research', confidence: 0.8, view: 'bullish' });
    commitMemory(store, 'semantic', 'bear', { entity: 'company:TCS', topic: 'sentiment', domain: 'research', confidence: 0.8, view: 'bearish' });
    const d = manager.decide({ subject: 'company:TCS', topic: 'sentiment', now: NOW });
    expect(d.decision).toBe('CONFLICT');
  });

  it('weak evidence → INSUFFICIENT', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'w', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.2 });
    const d = manager.decide({ subject: 'company:TCS', topic: 'sector', minConfidence: 0.9, evidenceThreshold: 2, now: NOW });
    expect(d.decision).toBe('INSUFFICIENT');
  });

  it('invalidation marker forces REFRESH even for fresh-looking records', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 's', sectorMemory());
    manager.invalidate({ targets: ['company:TCS'], cause: 'test', eventRef: 'ev-1', actor: 'tester' });
    const d = manager.decide({ subject: 'company:TCS', topic: 'sector', now: NOW });
    expect(d.decision).toBe('REFRESH');
    void store;
    void prov;
    void advance;
  });
});
