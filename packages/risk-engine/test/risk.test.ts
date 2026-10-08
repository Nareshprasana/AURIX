import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/index.js';
import type { RiskPolicy } from '@aurix/config-loader';

const POLICY: RiskPolicy = {
  version: 'v1',
  max_position_notional_pct: 2.0,
  max_portfolio_gross_pct: { paper_shadow: 60.0, controlled_live: 25.0 },
  max_sector_pct: 20.0,
  max_leverage: 1.0,
  max_margin_util_pct: 50.0,
  max_daily_loss_pct: 1.5,
  max_drawdown_pct: 8.0,
  liquidity_max_adv_pct: 5.0,
  liquidity_max_spread_bps: 50,
  concentration_top5_pct: 40.0,
  abnormal_market_haircut_pct: 50,
  abnormal_states: ['HALT', 'AUCTION', 'HIGH_VOLATILITY', 'EVENT_DRIVEN'],
  kill_switches: ['trade', 'strategy', 'agent', 'model', 'global']
};

const BASE_PORTFOLIO = {
  equity: 1_000_000,
  grossExposurePct: 10,
  sectorExposurePct: { Energy: 5 },
  dailyLossPct: 0.2,
  drawdownPct: 1.0,
  marginUtilPct: 10,
  leverage: 1.0
};

describe('risk-engine', () => {
  it('allows a small compliant proposal', () => {
    const v = evaluate(
      { instrumentId: 'X', notional: 10_000, quantity: 10, sector: 'Energy', eligibility: 'LEGAL', marketStatus: 'OPEN' },
      BASE_PORTFOLIO,
      POLICY
    );
    expect(v.allow).toBe(true);
    expect(v.policyVersion).toBe('v1');
  });

  it('rejects oversized proposal', () => {
    const v = evaluate(
      { instrumentId: 'X', notional: 500_000, quantity: 500, sector: 'Energy', eligibility: 'LEGAL', marketStatus: 'OPEN' },
      BASE_PORTFOLIO,
      POLICY
    );
    expect(v.allow).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/oversized/);
  });

  it('rejects sector exposure violation', () => {
    const v = evaluate(
      { instrumentId: 'X', notional: 1_000, quantity: 1, sector: 'Energy', eligibility: 'LEGAL', marketStatus: 'OPEN' },
      { ...BASE_PORTFOLIO, sectorExposurePct: { Energy: 20 } },
      POLICY
    );
    expect(v.allow).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/sector/);
  });

  it('rejects UNKNOWN eligibility (fail-closed)', () => {
    for (const e of ['UNKNOWN', 'RESTRICTED', 'UNAVAILABLE'] as const) {
      const v = evaluate(
        { instrumentId: 'X', notional: 1_000, quantity: 1, sector: 'Energy', eligibility: e, marketStatus: 'OPEN' },
        BASE_PORTFOLIO,
        POLICY
      );
      expect(v.allow).toBe(false);
    }
  });

  it('rejects invalid market state', () => {
    for (const s of ['HALT', 'AUCTION', 'UNKNOWN'] as const) {
      const v = evaluate(
        { instrumentId: 'X', notional: 1_000, quantity: 1, sector: 'Energy', eligibility: 'LEGAL', marketStatus: s },
        BASE_PORTFOLIO,
        POLICY
      );
      expect(v.allow).toBe(false);
    }
  });
});
