import { describe, expect, it } from 'vitest';
import { buildCapital, computeExposure, concentration, correlationView, sectorExposure } from '../src/index.js';
import { pos, PROFILE } from './helpers.js';

describe('capital model', () => {
  it('tracks reserved and locked margin as undeployable', () => {
    const c = buildCapital({ total: 1_000_000, reserved_pct: 10, base_currency: 'INR' }, 200_000, 50_000);
    expect(c.reserved).toBe(100_000);
    expect(c.cash).toBe(700_000);
    expect(c.available).toBe(650_000);
    expect(c.free_margin).toBe(650_000);
  });

  it('rejects non-positive capital', () => {
    expect(() => buildCapital({ total: 0, reserved_pct: 0, base_currency: 'INR' }, 0, 0)).toThrow(/CAPITAL_INVALID/);
  });
});

describe('exposure', () => {
  it('computes gross/net/long/short exactly', () => {
    const e = computeExposure([pos('A', 100_000), pos('B', -50_000)], 1_000_000);
    expect(e).toMatchObject({ gross: 150_000, net: 50_000, long: 100_000, short: 50_000 });
    expect(e.gross_pct).toBeCloseTo(15);
    expect(e.net_pct).toBeCloseTo(5);
  });

  it('handles empty portfolios', () => {
    expect(computeExposure([], 1_000_000)).toMatchObject({ gross: 0, net: 0 });
  });
});

describe('concentration', () => {
  it('measures top-N shares and HHI', () => {
    const c = concentration([pos('A', 50), pos('B', 30), pos('C', 20)]);
    expect(c.top1_pct).toBeCloseTo(50);
    expect(c.top5_pct).toBeCloseTo(100);
    expect(c.hhi).toBeCloseTo(0.25 + 0.09 + 0.04);
  });
});

describe('sector exposure via knowledge entity ids', () => {
  it('buckets by sector and isolates unknowns (never zeroed)', () => {
    const positions = [pos('A', 60_000, { sector: 'Banks' }), pos('B', 30_000, { sector: null }), pos('C', 10_000)];
    const r = sectorExposure(positions, { A: 'Banks' });
    expect(r.bySector).toEqual({ Banks: 60_000 });
    expect(r.unknown_pct).toBeCloseTo(40);
    expect(r.unknownIds.sort()).toEqual(['B', 'C']);
  });
});

describe('correlation view', () => {
  it('finds clusters and lists unknown pairs', () => {
    const view = correlationView({ A: { A: 1, B: 0.9, C: null }, B: { A: 0.9, B: 1, C: 0.1 }, C: { A: null, B: 0.1, C: 1 } });
    const clusters = view.clusterExposure({ A: 3, B: 3, C: 3 }, 0.7);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.pair).toBe('A|B');
    expect(clusters[0]?.combined_pct).toBe(6);
    expect(view.unknownPairs).toEqual([['A', 'C']]);
  });
});
