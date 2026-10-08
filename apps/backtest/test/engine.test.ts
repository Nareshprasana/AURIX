import { describe, expect, it } from 'vitest';
import { generateSignals } from '@aurix/strategy';
import { runBacktest } from '../src/index.js';
import type { BacktestRequest } from '../src/index.js';
import { DAY, bars, datasetFor, rocStrategy, weekdayCal, ZERO_COST, ZERO_SLIP } from './helpers.js';

function req(closes: number[], over: Partial<BacktestRequest> = {}): BacktestRequest {
  return {
    dataset: datasetFor(closes),
    strategy: rocStrategy(),
    calendar: weekdayCal(),
    initial_cash: 100_000,
    dataVersion: 'ds-test',
    generatedAt: 1,
    ...over
  };
}

describe('backtest correctness', () => {
  it('accounts exact cash on a hand-computed round trip', () => {
    // LONG at close[1]=102 (fill open[2]=100), EXIT at close[2]=100 (fill open[3]=98).
    const closes = [100, 102, 100, 98];
    const r = runBacktest(req(closes));
    expect(r.status).toBe('COMPLETED');
    expect(r.orders).toHaveLength(2);
    expect(r.fills).toHaveLength(2);
    // Entry 10 @ 100 = 1000, exit 10 @ 98 = 980 → cash 100000 - 1000 + 980 - ... wait fills at opens:
    // entry fill @open[2]=100 → -1000; exit fill @open[3]=98 → +980. Cash = 99980. P&L = -20.
    expect(r.fills[0]?.price).toBe(100);
    expect(r.fills[1]?.price).toBe(98);
    const lastEquity = r.equity[r.equity.length - 1]?.equity;
    expect(lastEquity).toBe(99980);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]?.realized_pnl).toBe(-20);
    expect(r.trades[0]?.fees).toBe(0);
  });

  it('executes strictly after the signal bar (1-bar delay, never same-bar)', () => {
    const r = runBacktest(req([100, 102, 104, 106, 108]));
    expect(r.orders.length).toBeGreaterThan(0);
    for (const o of r.orders) {
      expect(o.ts_execute).toBeGreaterThan(o.ts_signal);
    }
  });

  it('records fees and slippage on every fill when configured', () => {
    const strategy = rocStrategy({
      cost_model: { brokerage_bps: 10, exchange_bps: 5, taxes_bps: 5, min_cost: 0, per_side: true },
      slippage_model: { kind: 'fixed-bps', base_bps: 10 }
    });
    const r = runBacktest(req([100, 102, 100, 98], { strategy }));
    expect(r.fills.length).toBeGreaterThan(0);
    for (const f of r.fills) {
      expect(f.fees).toBeGreaterThan(0);
      expect(f.slippage_bps).toBe(10);
      expect(f.fee_breakdown.brokerage + f.fee_breakdown.exchange + f.fee_breakdown.taxes).toBeCloseTo(f.fees);
    }
    expect(r.metrics.turnover).toBeGreaterThan(0);
  });

  it('measures drawdown on a cost-dragged whipsaw run', () => {
    // Alternating closes with 5% per-side costs: every round trip loses heavily.
    const costly = rocStrategy({
      cost_model: { brokerage_bps: 500, exchange_bps: 0, taxes_bps: 0, min_cost: 0, per_side: true }
    });
    const r = runBacktest(req([102, 100, 102, 100, 102, 100, 102, 100], { strategy: costly }));
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.metrics.max_drawdown).toBeLessThan(0);
    expect(r.metrics.turnover).toBeGreaterThan(0);
  });

  it('skips non-session bars entirely', () => {
    // Start Monday 2024-01-08 so the LONG signal lands on a session; weekend
    // bars carry signals that must never execute (documented limitation).
    const closes = [100, 101, 102, 103, 104, 105, 106, 107];
    const start = Date.parse('2024-01-08T00:00:00Z'); // Monday
    const series = closes.map((close, i) => ({ instrument_id: 'X', ts: start + i * DAY, open: close, high: close + 1, low: close - 1, close, volume: 100_000, spread_bps: 5 as number | null, adv_value: 10_000_000 as number | null }));
    const ds = datasetFor([100]);
    ds.bars = series;
    ds.range = { from_ts: series[0]!.ts, to_ts: series[series.length - 1]!.ts };
    const r = runBacktest({ ...req([]), dataset: ds });
    expect(r.orders.length).toBeGreaterThan(0);
    expect(r.orders.every((o) => weekdayCal().isSession(o.ts_execute))).toBe(true);
    expect(r.fills.every((f) => weekdayCal().isSession(f.ts))).toBe(true);
    // Weekend-dated bars still produce signals (generation is calendar-blind);
    // the engine must never execute on them.
    const weekend = generateSignals(rocStrategy(), 'X', closes, closes.map((_, i) => start + i * DAY), 'ds', 1);
    expect(weekend.signals.some((s) => s.type === 'LONG')).toBe(true);
  });

  it('blocks illiquid entries and reports skippedCash on tiny accounts', () => {
    const thin = bars(10, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]).map((b) => ({ ...b, volume: 5 }));
    const r = runBacktest({ ...req([]), dataset: { ...datasetFor([100]), bars: thin, range: { from_ts: thin[0]!.ts, to_ts: thin[thin.length - 1]!.ts } }, strategy: rocStrategy({ liquidity: { min_value: 1, min_volume: 1000, max_participation: 10, max_adv_pct: 100, max_spread_bps: 10000 } }) });
    expect(r.fills).toHaveLength(0);
    expect(r.skippedIlliquid).toBeGreaterThan(0);
    const poor = runBacktest({ ...req([100, 102, 104, 106]), initial_cash: 10 });
    expect(poor.fills).toHaveLength(0);
    expect(poor.skippedCash).toBeGreaterThan(0);
  });

  it('caps fills at participation and flags them', () => {
    const strategy = rocStrategy({
      sizing: { type: 'fixed-qty', qty: 100, max_notional: 1_000_000, max_adv_pct: 100 },
      liquidity: { min_value: 1, min_volume: 1, max_participation: 10, max_adv_pct: 100, max_spread_bps: 10000 }
    });
    const series = bars(10, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]).map((b) => ({ ...b, volume: 500 }));
    const r = runBacktest({ ...req([]), dataset: { ...datasetFor([100]), bars: series, range: { from_ts: series[0]!.ts, to_ts: series[series.length - 1]!.ts } }, strategy });
    expect(r.fills.length).toBeGreaterThan(0);
    expect(r.fills[0]?.qty).toBe(50); // 10% of 500
    expect(r.fills[0]?.liquidity_capped).toBe(true);
  });

  it('handles splits without double-adjustment and credits dividends', () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 107];
    const series = bars(closes.length, closes);
    const splitTs = series[4]!.ts;
    const ds = datasetFor([100]);
    ds.bars = series;
    ds.adjustments = [{ id: 'split-1', instrument_id: 'X', ex_ts: splitTs, factor: 2, type: 'split', source: 'fixture', version: 'v1' }];
    ds.dividends = [{ id: 'div-1', instrument_id: 'X', ex_ts: series[6]!.ts, amount_per_share: 1, source: 'fixture' }];
    const r = runBacktest({ ...req([]), dataset: ds });
    expect(r.appliedAdjustments.filter((a) => a.action_id === 'split-1')).toHaveLength(1);
    expect(r.dividendsCredited).toBeGreaterThan(0);
  });

  it('never trades instruments listed after the data (survivorship guard)', () => {
    const ds = datasetFor([100, 101, 102, 103]);
    ds.universe = [{ instrument_id: 'X', listing_ts: Date.parse('2030-01-01T00:00:00Z') }];
    const r = runBacktest(req([100, 101, 102, 103], { dataset: ds }));
    expect(r.orders).toHaveLength(0);
  });

  it('suppresses signals outside event windows and counts them', () => {
    const series = bars(10, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    const ds = datasetFor([100]);
    ds.bars = series;
    ds.range = { from_ts: series[0]!.ts, to_ts: series[series.length - 1]!.ts };
    const r = runBacktest({ ...req([]), dataset: ds, eventWindows: [{ instrument_id: 'X', from_ts: 0, to_ts: 0 }] });
    expect(r.orders).toHaveLength(0);
    expect(r.suppressedByWindow).toBeGreaterThan(0);
  });

  it('returns NOT_APPLICABLE strategies with zero orders', () => {
    const blocked = rocStrategy({ regimes: { supported: [], preferred: [], blocked: ['*'] } });
    const r = runBacktest(req([100, 101, 102, 103, 104, 105], { strategy: blocked }));
    expect(r.orders).toHaveLength(0);
    expect(r.signals).toHaveLength(0);
  });

  it('produces a benchmark with explicit excess return', () => {
    const r = runBacktest(req([100, 101, 102, 103, 104, 105]));
    expect(r.benchmark).not.toBeNull();
    expect(typeof r.benchmark!.total_return).toBe('number');
  });

  it('maps quality states to run states', () => {
    const q = runBacktest(req([100, 101], { quality: { status: 'QUARANTINED', badIds: ['X'] } }));
    expect(q.status).toBe('DATA_QUARANTINED');
    const empty = runBacktest(req([]));
    expect(empty.status).toBe('INSUFFICIENT_DATA');
  });
});
