import { describe, expect, it } from 'vitest';
import { donchian, roc, sma, stdevLogReturns, stdevPrices, zscore } from '../src/index.js';

describe('indicators (look-ahead safe by index)', () => {
  it('sma computes trailing means and nulls during warmup', () => {
    expect(sma([1, 2, 3, 4, 5], 3, 1)).toBeNull();
    expect(sma([1, 2, 3, 4, 5], 3, 2)).toBeCloseTo(2);
    expect(sma([1, 2, 3, 4, 5], 3, 4)).toBeCloseTo(4);
  });

  it('roc measures trailing change', () => {
    expect(roc([100, 110], 1, 1)).toBeCloseTo(0.1);
    expect(roc([100, 110], 1, 0)).toBeNull();
  });

  it('stdev and zscore behave on flat vs trending data', () => {
    expect(stdevPrices([100, 100, 100, 100], 4, 3)).toBeCloseTo(0);
    expect(zscore([100, 100, 100, 100], 4, 3)).toBeNull(); // zero variance
    const z = zscore([100, 101, 102, 103, 120], 5, 4);
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThan(1);
    expect(stdevLogReturns([100, 101, 102], 2, 2)).toBeGreaterThan(0);
  });

  it('donchian tracks trailing extremes with lag support', () => {
    const d = donchian([1, 3, 2, 5, 4], 3, 4);
    expect(d).toEqual({ high: 5, low: 2 });
    expect(donchian([1, 2], 5, 1)).toBeNull();
  });
});
