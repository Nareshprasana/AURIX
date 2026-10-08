import { describe, expect, it } from 'vitest';
import { drawdownState, evaluatePortfolioRisk, PHASE1_DEFAULTS } from '../src/index.js';
import type { PortfolioRiskInput } from '../src/index.ts';

function baseInput(over: Partial<PortfolioRiskInput> = {}): PortfolioRiskInput {
  return {
    portfolio_id: 'port-1',
    candidates: [],
    current: { gross_pct: 0, sector_pct: {}, top5_pct: 0, leverage: 1, margin_pct: 0, daily_loss_pct: 0, drawdown_pct: 0 },
    market: { abnormal: false, haltedIds: [] },
    quality: {},
    trace_id: 'trace-1',
    ...over
  };
}

function candInput(id: string, weight: number, over: Record<string, unknown> = {}) {
  return {
    candidate: {
      candidate_id: `cand-${id}`,
      instrument: { instrument_id: id, exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: id },
      strategy_id: 'test:roc', strategy_version: 1, signal_type: 'LONG' as const,
      signal_strength: 0.8, signal_confidence: 0.7, expected_horizon_bars: 5,
      evidence_refs: [], regime: 'up_low',
      liquidity: { adv_value: 1e9, spread_bps: 5, volume: 1e6 },
      direction: 1 as const, reference_price: 100, invalidation: []
    },
    weight_pct: weight,
    sector: 'Banks',
    equity: 1_000_000,
    price: 100,
    strategyAuthorized: true,
    modeAllowsOrders: true,
    ...(over as Record<string, unknown>)
  } as never;
}

import type { DataQualityMap } from '../src/index.js';

function qualityFor(ids: string[]): DataQualityMap {
  const q: DataQualityMap = {};
  for (const id of ids) {
    for (const k of ['price', 'adv', 'spread', 'sector', 'vol']) q[`${k}:${id}`] = 'VALID';
  }
  return q;
}

describe('risk decisions', () => {
  it('allows compliant proposals with rule detail', () => {
    const r = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 1)], quality: qualityFor(['A']) }), PHASE1_DEFAULTS, 1);
    expect(r.portfolioVerdict).toBe('ALLOW');
    expect(r.candidates[0]?.verdict).toBe('ALLOW');
    expect(r.candidates[0]?.approved_weight_pct).toBe(1);
  });

  it('reduces oversized positions to the cap (risk wins over allocator)', () => {
    const r = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 8)], quality: qualityFor(['A']) }), PHASE1_DEFAULTS, 1);
    expect(r.candidates[0]?.verdict).toBe('REDUCE');
    expect(r.candidates[0]?.approved_weight_pct).toBeCloseTo(2);
    expect(r.candidates[0]?.reasons.join(' ')).toMatch(/cap/);
    expect(r.portfolioVerdict).toBe('REDUCE');
  });

  it('rejects halted, unauthorized and wrong-mode candidates', () => {
    const halted = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 1)], market: { abnormal: false, haltedIds: ['A'] }, quality: qualityFor(['A']) }), PHASE1_DEFAULTS, 1);
    expect(halted.candidates[0]?.verdict).toBe('REJECT');
    const unauth = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 1, { strategyAuthorized: false })], quality: qualityFor(['A']) }), PHASE1_DEFAULTS, 1);
    expect(unauth.candidates[0]?.verdict).toBe('REJECT');
    const mode = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 1, { modeAllowsOrders: false })], quality: qualityFor(['A']) }), PHASE1_DEFAULTS, 1);
    expect(mode.candidates[0]?.verdict).toBe('REJECT');
  });

  it('fails safe on UNKNOWN inputs (never ALLOW)', () => {
    for (const key of ['price', 'adv', 'spread', 'sector', 'vol']) {
      const q = qualityFor(['A']);
      q[`${key}:A`] = 'QUARANTINED';
      const r = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 1)], quality: q }), PHASE1_DEFAULTS, 1);
      expect(r.candidates[0]?.verdict).toBe('UNKNOWN');
      expect(r.portfolioVerdict).not.toBe('ALLOW');
    }
    const missing = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 1)], quality: {} }), PHASE1_DEFAULTS, 1);
    expect(missing.candidates[0]?.verdict).toBe('UNKNOWN');
  });

  it('rejects unknown-sector candidates instead of assuming zero', () => {
    const r = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 1, { sector: null })], quality: qualityFor(['A']) }), PHASE1_DEFAULTS, 1);
    expect(r.candidates[0]?.verdict).toBe('REJECT');
  });

  it('scales the book when gross headroom binds', () => {
    const many = ['A', 'B', 'C', 'D'].map((id) => candInput(id, 20));
    const r = evaluatePortfolioRisk(baseInput({ candidates: many, quality: qualityFor(['A', 'B', 'C', 'D']) }), PHASE1_DEFAULTS, 1);
    // position cap 2% binds first; gross stays within 60%.
    expect(r.grossPct).toBeLessThanOrEqual(60);
  });

  it('applies abnormal-market haircuts and blocks halts', () => {
    const calm = evaluatePortfolioRisk(baseInput({ candidates: [candInput('A', 1.5)], quality: qualityFor(['A']) }), PHASE1_DEFAULTS, 1);
    expect(calm.candidates[0]?.verdict).toBe('ALLOW');
    const rough = evaluatePortfolioRisk(
      baseInput({ candidates: [candInput('A', 1.5)], market: { abnormal: true, haltedIds: [] }, quality: qualityFor(['A']) }),
      PHASE1_DEFAULTS, 1
    );
    expect(rough.candidates[0]?.verdict).toBe('REDUCE'); // 2% cap halved to 1%
    expect(rough.candidates[0]?.approved_weight_pct).toBeCloseTo(1);
  });

  it('penalizes correlated clusters conservatively', () => {
    const ids = ['A', 'B', 'C', 'D'];
    const matrix: Record<string, Record<string, number | null>> = {};
    for (const a of ids) {
      matrix[a] = {};
      for (const b of ids) matrix[a]![b] = a === b ? 1 : 0.95;
    }
    const r = evaluatePortfolioRisk(baseInput({
      candidates: ids.map((id) => candInput(id, 2)),
      quality: qualityFor(ids),
      correlations: matrix
    }), PHASE1_DEFAULTS, 1);
    // 4 × 2% = 8% combined > 6% cluster cap → scaled to 1.5% each.
    expect(r.candidates.every((c) => c.verdict === 'REDUCE')).toBe(true);
    expect(r.candidates[0]?.approved_weight_pct).toBeCloseTo(1.5);
    expect(r.candidates[0]?.reasons.join(' ')).toMatch(/cluster/);
    // Uncorrelated names are untouched.
    const free = evaluatePortfolioRisk(baseInput({
      candidates: [candInput('A', 2), candInput('B', 2)],
      quality: qualityFor(['A', 'B']),
      correlations: { A: { B: 0.1 }, B: { A: 0.1 } }
    }), PHASE1_DEFAULTS, 1);
    expect(free.candidates.every((c) => c.verdict === 'ALLOW')).toBe(true);
  });

  it('drawdown machine: NORMAL/CAUTION/RESTRICTED/HALTED', () => {
    expect(drawdownState(1, 0, PHASE1_DEFAULTS)).toBe('NORMAL');
    expect(drawdownState(5, 0, PHASE1_DEFAULTS)).toBe('CAUTION');
    expect(drawdownState(7, 0, PHASE1_DEFAULTS)).toBe('RESTRICTED');
    expect(drawdownState(8, 0, PHASE1_DEFAULTS)).toBe('HALTED');
    expect(drawdownState(1, 1.5, PHASE1_DEFAULTS)).toBe('HALTED');
    const halted = evaluatePortfolioRisk(baseInput({
      candidates: [candInput('A', 1)], quality: qualityFor(['A']),
      current: { gross_pct: 0, sector_pct: {}, top5_pct: 0, leverage: 1, margin_pct: 0, daily_loss_pct: 2, drawdown_pct: 1 }
    }), PHASE1_DEFAULTS, 1);
    expect(halted.portfolioVerdict).toBe('REJECT');
  });
});
