import { describe, expect, it } from 'vitest';
import { ModeMachine, createDraftPromotion, isLiveAllowed } from '../src/index.js';

describe('orchestrator', () => {
  it('defaults to RESEARCH with no orders allowed', () => {
    const m = new ModeMachine();
    expect(m.mode).toBe('RESEARCH');
    expect(m.allowsOrders()).toBe(false);
  });

  it('allows SHADOW/PAPER transitions, blocks live', () => {
    const m = new ModeMachine();
    m.transition('PAPER');
    expect(m.allowsOrders()).toBe(true);
    expect(() => m.transition('AUTONOMOUS_LIVE')).toThrow(/impossible/);
    expect(() => m.transition('CONTROLLED_LIVE')).toThrow(/impossible/);
  });

  it('promotion starts DRAFT and never allows live in Phase 1', () => {
    const p = createDraftPromotion('1.0.1');
    expect(p.state).toBe('DRAFT');
    expect(isLiveAllowed(p, 'PAPER')).toBe(false);
    expect(isLiveAllowed({ ...p, state: 'ACTIVE' }, 'AUTONOMOUS_LIVE')).toBe(false);
  });
});
