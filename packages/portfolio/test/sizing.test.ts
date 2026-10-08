import { describe, expect, it } from 'vitest';
import { finalizeSize, sizeFixedFraction, sizeLiquidityConstrained, sizeMaxLoss, sizeRiskBudget, sizeVolatilityTarget } from '../src/index.js';

const BASE = { instrument_id: 'X', weight_pct: 1, equity: 1_000_000, price: 100 };

describe('position sizing', () => {
  it('fixed fraction converts weight to bounded qty', () => {
    const r = sizeFixedFraction(BASE, 2);
    expect(r.qty).toBe(200);
    expect(r.notional).toBe(20_000);
    expect(() => sizeFixedFraction(BASE, 0)).toThrow(/SIZING_INVALID/);
  });

  it('volatility targeting sizes inversely, zero on unknown vol', () => {
    const sized = sizeVolatilityTarget({ ...BASE, volatility: 0.5, target_vol_pct: 1 });
    // notional = 1M * 1% / 0.5 = 20k → 200 shares
    expect(sized.qty).toBe(200);
    const unknown = sizeVolatilityTarget(BASE);
    expect(unknown.qty).toBe(0);
    expect(unknown.capped_by).toContain('volatility-unknown');
  });

  it('risk budget derives qty from stop distance', () => {
    // risk 10k (1%), stop 5% of 100 = 5 → 2000 shares
    const r = sizeRiskBudget({ ...BASE, risk_budget_pct: 1, stop_distance_pct: 5 });
    expect(r.qty).toBe(2000);
    expect(sizeRiskBudget({ ...BASE, stop_distance_pct: 0 }).qty).toBe(0);
    expect(sizeMaxLoss({ ...BASE, risk_budget_pct: 1, stop_distance_pct: 5 }).qty).toBe(2000);
  });

  it('liquidity sizing refuses unknown ADV (never assumes liquid)', () => {
    expect(sizeLiquidityConstrained(BASE).qty).toBe(0);
    const r = sizeLiquidityConstrained({ ...BASE, adv_value: 1_000_000 }, 5);
    expect(r.qty).toBe(500); // 5% of 1M / 100
    expect(r.capped_by).toContain('adv-cap');
  });

  it('final size is the minimum across methods and risk caps', () => {
    const a = sizeFixedFraction(BASE, 2); // 200
    const b = sizeVolatilityTarget({ ...BASE, volatility: 2, target_vol_pct: 1 }); // 50
    const final = finalizeSize([a, b], 5_000, 100); // risk allows 50
    expect(final.qty).toBe(50);
    expect(final.capped_by).toContain('sizing-methods');
    const riskBound = finalizeSize([a], 1_000, 100); // risk allows 10
    expect(riskBound.qty).toBe(10);
    expect(riskBound.capped_by).toContain('risk-cap');
  });
});
