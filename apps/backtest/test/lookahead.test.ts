import { describe, expect, it } from 'vitest';
import { FAMILY_PRESETS, generateSignals } from '@aurix/strategy';
import { adjustSeries, barsAsOf, eventsAsOf, fundamentalsAsOf, universeAsOf } from '../src/index.js';
import { runBacktest } from '../src/index.js';
import type { BacktestDataset } from '../src/index.js';
import { DAY, bars, datasetFor, rocStrategy, weekdayCal } from './helpers.js';

function smaDef() {
  const c = FAMILY_PRESETS['sma-cross']!.build({ fast: 2, slow: 3 });
  return {
    id: 'test:sma', version: 1, name: 't', description: 't', family: 'trend' as const,
    scope: { markets: ['equity'], segments: ['EQ'], timeframes: ['1D'], universe: ['X'] },
    entry_long: c.entry_long, entry_short: c.entry_short, exit: c.exit,
    sizing: { type: 'fixed-qty' as const, qty: 10, max_notional: 1_000_000, max_adv_pct: 100 as number as number },
    signal_horizon_bars: 5, required_observations: [], required_data: ['ohlcv'], required_events: [],
    assumptions: [], cost_model: { brokerage_bps: 0, exchange_bps: 0, taxes_bps: 0, min_cost: 0, per_side: true },
    slippage_model: { kind: 'fixed-bps' as const, base_bps: 0 },
    liquidity: { min_value: 1, min_volume: 1, max_participation: 100, max_adv_pct: 100, max_spread_bps: 10000 },
    regimes: { supported: [], preferred: [], blocked: [] },
    params: { fast: 2, slow: 3 }, param_bounds: { fast: [2, 50] as [number, number], slow: [5, 200] as [number, number] },
    created_at: 1, author: 'test',
    provenance: { source: 'test', source_type: 'agent' as const, evidence_refs: [] },
    evidence_refs: [], status: 'CANDIDATE' as const
  };
}

describe('no look-ahead bias', () => {
  it('prefix signals are identical with or without future bars', () => {
    const def = smaDef();
    const full = [100, 101, 102, 103, 104, 120, 121, 122, 123, 124, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89];
    const prefix = full.slice(0, 10);
    const ts = (n: number) => Array.from({ length: n }, (_, i) => i);
    const a = generateSignals(def, 'X', prefix, ts(10), 'ds', 1).signals.map((s) => s.type);
    const b = generateSignals(def, 'X', full, ts(20), 'ds', 1).signals.slice(0, 10).map((s) => s.type);
    expect(a).toEqual(b);
  });

  it('engine equity prefix is invariant to appended future data', () => {
    const mk = (closes: number[]) => {
      const series = bars(closes.length, closes);
      const ds = datasetFor([0]);
      ds.bars = series;
      ds.range = { from_ts: series[0]!.ts, to_ts: series[series.length - 1]!.ts };
      return runBacktest({
        dataset: ds, strategy: rocStrategy(), calendar: weekdayCal(),
        initial_cash: 100_000, dataVersion: 'ds', generatedAt: 1
      });
    };
    const short = mk([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    const long = mk([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 200, 201, 202, 203, 204, 205]);
    expect(long.equity.slice(0, short.equity.length).map((e) => e.equity)).toEqual(short.equity.map((e) => e.equity));
  });

  it('fundamentals are visible only after publication', () => {
    const ds = datasetFor([100, 101]);
    ds.fundamentals = [
      { instrument_id: 'X', metric: 'eps', value: 5, period: 'Q1', published_at: 200, source: 'filing' },
      { instrument_id: 'X', metric: 'eps', value: 6, period: 'Q2', published_at: 300, source: 'filing' }
    ];
    expect(fundamentalsAsOf(ds, 250).map((f) => f.value)).toEqual([5]);
    expect(fundamentalsAsOf(ds, 199)).toHaveLength(0);
    expect(fundamentalsAsOf(ds, 300).map((f) => f.value)).toEqual([5, 6]);
  });

  it('corporate actions apply from ex-date, never before', () => {
    const ds = datasetFor([100, 101, 102, 103]);
    ds.events = [
      { event_id: 'e1', event_type: 'split', entity_refs: [], instrument_ids: ['X'], occurred_at: ds.bars[2]!.ts }
    ];
    expect(eventsAsOf(ds, ds.bars[1]!.ts)).toHaveLength(0);
    expect(eventsAsOf(ds, ds.bars[2]!.ts)).toHaveLength(1);
  });

  it('universe membership respects listing dates (no survivorship leak)', () => {
    const base = datasetFor([100, 101]);
    const ds: BacktestDataset = {
      ...base,
      universe: [
        { instrument_id: 'OLD', listing_ts: 0 },
        { instrument_id: 'NEW', listing_ts: base.bars[1]!.ts + DAY }
      ]
    };
    expect(universeAsOf(ds, ds.bars[0]!.ts)).toEqual(['OLD']);
    expect(universeAsOf(ds, ds.bars[1]!.ts + DAY)).toContain('NEW');
  });

  it('split-adjusted series carry no spurious breakout signal', () => {
    // Raw: 100s then post-split 50s. Adjusted: continuous ~100s → no breakout.
    const raw = [100, 100, 100, 100, 100, 50, 50, 50, 50, 50];
    const series = bars(raw.length, raw);
    const ds = datasetFor([0]);
    ds.bars = series;
    ds.adjustments = [{ id: 's', instrument_id: 'X', ex_ts: series[5]!.ts, factor: 2, type: 'split', source: 'f', version: 'v1' }];
    const adjusted = adjustSeries(ds).find((s) => s.instrument_id === 'X')!;
    expect(adjusted.applied).toHaveLength(1);
    expect(Math.max(...adjusted.bars.map((b) => b.close)) - Math.min(...adjusted.bars.map((b) => b.close))).toBeLessThan(0.01);
    expect(barsAsOf(adjusted, series[3]!.ts)).toHaveLength(4);
  });
});
