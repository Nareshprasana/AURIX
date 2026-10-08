import { describe, expect, it } from 'vitest';
import { compareBenchmark, computeMetrics, evaluateStrategy } from '../src/index.js';
import type { PerformanceMetrics, Trade } from '../src/index.js';

function trade(pnl: number, i: number): Trade {
  return {
    trade_id: `t${i}`, instrument_id: 'X', direction: 1, entry_ts: i, entry_price: 100,
    exit_ts: i + 1, exit_price: 100 + pnl, qty: 1, realized_pnl: pnl,
    fees: 0, holding_bars: 1, status: 'CLOSED'
  };
}

const BASE_METRICS: PerformanceMetrics = {
  total_return: 0.2, cagr: 0.1, volatility: 0.15, max_drawdown: -0.1, max_dd_duration_bars: 5,
  downside_dev: 0.1, sharpe: 1.2, sortino: 1.5, calmar: 1.0, trades: 20, win_rate: 0.6,
  avg_win: 10, avg_loss: -5, profit_factor: 2, turnover: 1000, avg_holding_bars: 5,
  worst_day: -0.02, worst_trade: -8, loss_streak: 2, concentration: 0.3
};

describe('performance metrics', () => {
  it('computes exact metrics on a known equity curve', () => {
    const m = computeMetrics([1000, 1100, 1050, 1150], [], 1000, 252);
    expect(m.total_return).toBeCloseTo(0.15);
    expect(m.max_drawdown).toBeCloseTo((1050 - 1100) / 1100);
    expect(m.trades).toBe(0);
  });

  it('derives trade statistics from closed trades', () => {
    const m = computeMetrics([1000, 1000], [trade(10, 1), trade(10, 2), trade(-5, 3)], 1000);
    expect(m.trades).toBe(3);
    expect(m.win_rate).toBeCloseTo(2 / 3);
    expect(m.profit_factor).toBeCloseTo(4);
    expect(m.worst_trade).toBe(-5);
    expect(m.loss_streak).toBe(1);
  });

  it('compares against benchmarks explicitly', () => {
    const cmp = compareBenchmark(BASE_METRICS, { ...BASE_METRICS, total_return: 0.1, volatility: 0.12, max_drawdown: -0.05 });
    expect(cmp.excess_return).toBeCloseTo(0.1);
    expect(cmp.strategy_return).toBe(0.2);
    expect(cmp.benchmark_return).toBe(0.1);
  });
});

describe('evaluation framework', () => {
  it('rejects unprofitable or tail-risky strategies', () => {
    expect(evaluateStrategy({ inSample: { ...BASE_METRICS, total_return: -0.1 }, inSampleTrades: 20, inSampleBars: 200 }).label).toBe('REJECTED');
    expect(evaluateStrategy({ inSample: { ...BASE_METRICS, max_drawdown: -0.5 }, inSampleTrades: 20, inSampleBars: 200 }).label).toBe('REJECTED');
  });

  it('never approves on returns alone; demands breadth', () => {
    const weak = evaluateStrategy({ inSample: BASE_METRICS, inSampleTrades: 20, inSampleBars: 200 });
    expect(weak.label).toBe('WEAK');
    const promising = evaluateStrategy({
      inSample: BASE_METRICS, inSampleTrades: 20, inSampleBars: 200,
      oos: { ...BASE_METRICS, total_return: 0.05, sharpe: 0.8 }
    });
    expect(promising.label).toBe('PROMISING');
  });

  it('detects degradation and rewards full validation', () => {
    const deg = evaluateStrategy({
      inSample: BASE_METRICS, inSampleTrades: 20, inSampleBars: 200,
      oos: { ...BASE_METRICS, total_return: 0.02, sharpe: 0.3 }
    });
    expect(deg.label).toBe('DEGRADED');
    const robust = evaluateStrategy({
      inSample: BASE_METRICS, inSampleTrades: 20, inSampleBars: 200,
      oos: { ...BASE_METRICS, total_return: 0.12, sharpe: 1.0 },
      walkForward: { windows: 3, aggregate: BASE_METRICS },
      stressWorstDd: -0.12, paramStable: true, sweepCount: 9
    });
    expect(robust.label).toBe('ROBUST');
  });

  it('flags insufficient data and invalid methodology', () => {
    expect(evaluateStrategy({ inSample: BASE_METRICS, inSampleTrades: 5, inSampleBars: 200 }).label).toBe('INSUFFICIENT_DATA');
    expect(evaluateStrategy({ inSample: BASE_METRICS, inSampleTrades: 20, inSampleBars: 200, methodologyFlags: ['look-ahead-suspect'] }).label).toBe('INVALID');
    expect(evaluateStrategy({ inSample: BASE_METRICS, inSampleTrades: 20, inSampleBars: 200, sweepCount: 200 }).label).toBe('WEAK');
  });
});
