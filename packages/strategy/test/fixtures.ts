import { FAMILY_PRESETS, validateDefinition } from '../src/index.js';
import type { CostModel, LiquidityPolicy, SlippageModel, StrategyDefinition } from '../src/index.js';

export const COST: CostModel = { brokerage_bps: 5, exchange_bps: 2, taxes_bps: 3, min_cost: 0, per_side: true };
export const SLIP: SlippageModel = { kind: 'fixed-bps', base_bps: 5 };
export const LIQ: LiquidityPolicy = { min_value: 1000, min_volume: 100, max_participation: 10, max_adv_pct: 5, max_spread_bps: 100 };

export function makeDef(over: Partial<StrategyDefinition> = {}, preset = 'sma-cross', params: Record<string, number> = { fast: 5, slow: 20 }): StrategyDefinition {
  const conditions = FAMILY_PRESETS[preset]!.build(params);
  return {
    id: 'test:sma',
    version: 1,
    name: 'test',
    description: 'fixture',
    family: 'trend',
    scope: { markets: ['equity'], segments: ['EQ'], timeframes: ['1D'], universe: ['X'] },
    entry_long: conditions.entry_long,
    entry_short: conditions.entry_short,
    exit: conditions.exit,
    sizing: { type: 'fixed-qty', qty: 10, max_notional: 1_000_000, max_adv_pct: 5 },
    signal_horizon_bars: 5,
    required_observations: [],
    required_data: ['ohlcv'],
    required_events: [],
    assumptions: [],
    cost_model: { ...COST },
    slippage_model: { ...SLIP },
    liquidity: { ...LIQ },
    regimes: { supported: [], preferred: [], blocked: [] },
    params: { ...params },
    param_bounds: { ...FAMILY_PRESETS[preset]!.bounds },
    created_at: 1,
    author: 'test',
    provenance: { source: 'test', source_type: 'agent', evidence_refs: [] },
    evidence_refs: [],
    status: 'CANDIDATE',
    ...over
  };
}

/** Steady uptrend: 30 bars rising 1/day from 100. */
export function trendCloses(n = 30, start = 100): number[] {
  return Array.from({ length: n }, (_, i) => start + i);
}

/** Choppy sideways: alternates 100/101. */
export function rangeCloses(n = 30): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 100 : 101));
}

export function timestamps(n: number, start = Date.parse('2024-01-01T00:00:00Z')): number[] {
  return Array.from({ length: n }, (_, i) => start + i * 86_400_000);
}
