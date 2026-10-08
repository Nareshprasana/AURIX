import { describe, expect, it } from 'vitest';
import { ALLOCATORS, allocateConfidence, allocateEqual, allocateHybrid, allocateInverseVol, allocateSignal } from '../src/index.js';
import type { PortfolioCandidate } from '../src/index.js';

function cand(id: string, strength = 0.8, confidence = 0.7): PortfolioCandidate {
  return {
    candidate_id: `cand-${id}`,
    instrument: { instrument_id: id, exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: id },
    strategy_id: 'test:roc',
    strategy_version: 1,
    signal_type: 'LONG',
    signal_strength: strength,
    signal_confidence: confidence,
    expected_horizon_bars: 5,
    evidence_refs: [],
    regime: 'up_low',
    liquidity: { adv_value: 1e9, spread_bps: 5, volume: 1e6 },
    direction: 1,
    reference_price: 100,
    invalidation: []
  };
}

describe('allocation methods', () => {
  it('equal weights 1/N with caps', () => {
    const r = allocateEqual([cand('A'), cand('B'), cand('C'), cand('D')], 2);
    expect(Object.values(r.weights)).toHaveLength(4);
    for (const w of Object.values(r.weights)) expect(w).toBeLessThanOrEqual(2);
    expect(r.explanation.join(' ')).toMatch(/equal/);
  });

  it('signal weights follow normalized strength', () => {
    const r = allocateSignal([cand('A', 0.9), cand('B', 0.1)], 100);
    expect(r.weights['A']).toBeGreaterThan(r.weights['B']!);
    expect(r.weights['A']! + r.weights['B']!).toBeCloseTo(100);
  });

  it('risk/volatility weights punish high-vol names', () => {
    const cs = [cand('A'), cand('B')];
    const r = allocateInverseVol(cs, { A: 0.5, B: 0.1 }, 100);
    expect(r.weights['B']).toBeGreaterThan(r.weights['A']!);
    const unknown = allocateInverseVol(cs, {}, 100);
    expect(Object.values(unknown.weights).every((w) => w === 50)).toBe(true); // falls back to equal
  });

  it('confidence weights use validated confidence (not probability)', () => {
    const r = allocateConfidence([cand('A', 0.8, 0.9), cand('B', 0.8, 0.3)], 100);
    expect(r.weights['A']).toBeGreaterThan(r.weights['B']!);
  });

  it('hybrid blends deterministically and is bounded', () => {
    const cs = [cand('A', 0.9, 0.9), cand('B', 0.4, 0.5)];
    const r = allocateHybrid(cs, { volatilities: { A: 0.2, B: 0.4 }, liquidityScores: { A: 0.9, B: 0.5 } }, 100);
    expect(r.weights['A']).toBeGreaterThan(r.weights['B']!);
    const capped = allocateHybrid(cs, {}, 0.01);
    expect(Math.max(...Object.values(capped.weights))).toBeLessThanOrEqual(0.01);
    expect(capped.capped.length).toBeGreaterThan(0);
  });

  it('empty candidate set yields empty weights (NO_TRADE input)', () => {
    for (const m of Object.keys(ALLOCATORS) as (keyof typeof ALLOCATORS)[]) {
      expect(ALLOCATORS[m]([], {}).weights).toEqual({});
    }
  });

  it('all methods are deterministic', () => {
    const cs = [cand('A', 0.7), cand('B', 0.3)];
    const a = allocateHybrid(cs, { volatilities: { A: 0.2, B: 0.3 } }, 100);
    const b = allocateHybrid(cs, { volatilities: { A: 0.2, B: 0.3 } }, 100);
    expect(a).toEqual(b);
  });
});
