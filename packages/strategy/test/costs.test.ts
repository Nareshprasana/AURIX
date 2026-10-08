import { describe, expect, it } from 'vitest';
import { checkLiquidity, computeCost, computeSlippage, TradingCalendar } from '../src/index.js';
import { COST, LIQ } from './fixtures.js';

describe('costs and slippage', () => {
  it('splits fees into recorded components with minimums', () => {
    const c = computeCost(100_000, COST);
    expect(c.total).toBeCloseTo(100_000 * 0.001);
    expect(c.brokerage + c.exchange + c.taxes).toBeCloseTo(c.total);
    const tiny = computeCost(100, { ...COST, min_cost: 5 });
    expect(tiny.total).toBe(5);
  });

  it('fixed slippage is exact; liquidity-aware scales with size', () => {
    expect(computeSlippage(1000, { kind: 'fixed-bps', base_bps: 5 }, { spread_bps: 10, adv_value: 1e9 }).slippage_bps).toBe(5);
    const small = computeSlippage(1_000, { kind: 'liquidity-aware', base_bps: 2, spread_share: 0.5, impact_coeff: 0.1 }, { spread_bps: 10, adv_value: 1e9 });
    const big = computeSlippage(100_000_000, { kind: 'liquidity-aware', base_bps: 2, spread_share: 0.5, impact_coeff: 0.1 }, { spread_bps: 10, adv_value: 1e9 });
    expect(big.slippage_bps).toBeGreaterThan(small.slippage_bps);
  });

  it('unknown ADV degrades with a recorded assumption, never silently', () => {
    const r = computeSlippage(1000, { kind: 'liquidity-aware', base_bps: 2 }, { spread_bps: null, adv_value: null });
    expect(r.assumed.length).toBeGreaterThan(0);
    expect(r.slippage_bps).toBeGreaterThanOrEqual(2);
  });
});

describe('liquidity guards', () => {
  it('blocks entries on thin or unknown liquidity, caps exits', () => {
    expect(checkLiquidity(500, 50, 1e9, 10, 10, LIQ, false).ok).toBe(false); // below minimums
    expect(checkLiquidity(10_000, 10_000, null, 10, 10, LIQ, false).ok).toBe(false); // UNKNOWN adv
    expect(checkLiquidity(10_000, 10_000, null, 10, 10, LIQ, false).unknown).toBe(true);
    const exit = checkLiquidity(10_000, 10_000, null, 10, 10, LIQ, true);
    expect(exit.ok).toBe(true); // exits pass capped, never blocked
    const capped = checkLiquidity(100_000, 100, 1e9, 10, 50, { ...LIQ, max_participation: 10 }, false);
    expect(capped.cappedQty).toBe(10);
  });

  it('rejects wide spreads on entry', () => {
    expect(checkLiquidity(100_000, 10_000, 1e9, 500, 10, LIQ, false).ok).toBe(false);
  });
});

describe('trading calendar', () => {
  it('skips weekends and holidays; sessions gate execution', () => {
    const cal = TradingCalendar.weekdays('2024-01-01', '2024-01-15', ['2024-01-02']);
    expect(cal.isSession(Date.parse('2024-01-06T00:00:00Z'))).toBe(false); // Saturday
    expect(cal.isSession(Date.parse('2024-01-02T00:00:00Z'))).toBe(false); // holiday
    expect(cal.isSession(Date.parse('2024-01-03T00:00:00Z'))).toBe(true);
    expect(cal.nextSession(Date.parse('2024-01-05T00:00:00Z'))).toBe(Date.parse('2024-01-08T00:00:00Z'));
    expect(cal.version).toBe('cal-weekday-v1');
  });

  it('never treats non-sessions as tradable', () => {
    const cal = new TradingCalendar('test', []);
    expect(cal.isSession(Date.now())).toBe(false);
    expect(cal.nextSession(Date.now())).toBeNull();
  });
});
