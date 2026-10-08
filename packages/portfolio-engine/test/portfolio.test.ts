import { describe, expect, it } from 'vitest';
import { computeExposure } from '../src/index.js';

describe('portfolio-engine', () => {
  it('computes gross + sector exposure', () => {
    const r = computeExposure(1_000_000, [
      { instrumentId: 'A', sector: 'Energy', notional: 100_000 },
      { instrumentId: 'B', sector: 'Banks', notional: 50_000 }
    ]);
    expect(r.grossExposurePct).toBeCloseTo(15);
    expect(r.sectorExposurePct['Energy']).toBeCloseTo(10);
  });

  it('handles zero equity safely', () => {
    expect(computeExposure(0, []).grossExposurePct).toBe(0);
  });
});
