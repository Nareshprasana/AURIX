import { FAMILY_PRESETS, TradingCalendar } from '@aurix/strategy';
import type { CostModel, LiquidityPolicy, SlippageModel, StrategyDefinition } from '@aurix/strategy';
import type { BacktestDataset, DatasetBar } from '../src/index.js';
import { buildDataset } from '../src/index.js';

export const DAY = 86_400_000;
export const T0 = Date.parse('2024-01-01T00:00:00Z');

export function bars(n: number, closes: number[], id = 'X', startTs = T0): DatasetBar[] {
  return closes.map((close, i) => ({
    instrument_id: id,
    ts: startTs + i * DAY,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100_000,
    spread_bps: 5,
    adv_value: 10_000_000
  }));
}

export const ZERO_COST: CostModel = { brokerage_bps: 0, exchange_bps: 0, taxes_bps: 0, min_cost: 0, per_side: true };
export const ZERO_SLIP: SlippageModel = { kind: 'fixed-bps', base_bps: 0 };
export const LOOSE_LIQ: LiquidityPolicy = { min_value: 1, min_volume: 1, max_participation: 100, max_adv_pct: 100, max_spread_bps: 10_000 };

export function weekdayCal(from = '2024-01-01', to = '2024-06-30'): TradingCalendar {
  return TradingCalendar.weekdays(from, to, [], 'cal-test-v1');
}

export function rocStrategy(over: Partial<StrategyDefinition> = {}): StrategyDefinition {
  const conditions = FAMILY_PRESETS['roc-momentum']!.build({ n: 1, threshold: 0 });
  return {
    id: 'test:roc',
    version: 1,
    name: 'roc fixture',
    description: 'test-only momentum',
    family: 'momentum',
    scope: { markets: ['equity'], segments: ['EQ'], timeframes: ['1D'], universe: ['X'] },
    entry_long: conditions.entry_long,
    entry_short: conditions.entry_short,
    exit: conditions.exit,
    sizing: { type: 'fixed-qty', qty: 10, max_notional: 1_000_000, max_adv_pct: 100 },
    signal_horizon_bars: 5,
    required_observations: [],
    required_data: ['ohlcv'],
    required_events: [],
    assumptions: [],
    cost_model: { ...ZERO_COST },
    slippage_model: { ...ZERO_SLIP },
    liquidity: { ...LOOSE_LIQ },
    regimes: { supported: [], preferred: [], blocked: [] },
    params: { n: 1, threshold: 0 },
    param_bounds: { n: [1, 10], threshold: [0, 1] },
    family_preset: 'roc-momentum',
    created_at: 1,
    author: 'test',
    provenance: { source: 'test', source_type: 'agent', evidence_refs: [] },
    evidence_refs: [],
    status: 'CANDIDATE',
    ...over
  };
}

export function datasetFor(closes: number[], id = 'X', extra: Partial<BacktestDataset> = {}): BacktestDataset {
  return buildDataset({
    id: `ds-${id}`,
    timeframe: '1D',
    bars: bars(closes.length, closes, id),
    calendar_version: 'cal-test-v1',
    source: 'fixture',
    ...extra
  });
}
