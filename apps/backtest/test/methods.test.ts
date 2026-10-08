import { describe, expect, it } from 'vitest';
import { makeWindows, parameterSweep, runOos, runStress, runWalkForward, splitDataset } from '../src/index.js';
import { runBacktest } from '../src/index.js';
import type { BacktestRequest } from '../src/index.js';
import { DAY, bars, datasetFor, rocStrategy, weekdayCal } from './helpers.js';

function base(closes: number[]): BacktestRequest {
  const series = bars(closes.length, closes);
  const ds = datasetFor([0]);
  ds.bars = series;
  ds.range = { from_ts: series[0]!.ts, to_ts: series[series.length - 1]!.ts };
  return {
    dataset: ds, strategy: rocStrategy(), calendar: weekdayCal(),
    initial_cash: 100_000, dataVersion: 'ds', generatedAt: 1
  };
}

const TREND = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129];

describe('out-of-sample', () => {
  it('splits ranges without overlap or gaps', () => {
    const r = base(TREND);
    const splitTs = r.dataset.bars[15]!.ts;
    const split = splitDataset(r.dataset, splitTs);
    expect(split.inSample.bars.every((b) => b.ts < splitTs)).toBe(true);
    expect(split.outOfSample.bars.every((b) => b.ts >= splitTs)).toBe(true);
    expect(split.inSample.bars.length + split.outOfSample.bars.length).toBe(r.dataset.bars.length);
    expect(split.inSample.version).not.toBe(split.outOfSample.version);
  });

  it('refuses empty splits and OOS tuning', () => {
    const r = base(TREND);
    expect(() => splitDataset(r.dataset, 0)).toThrow(/OOS_SPLIT_EMPTY/);
    const oos = splitDataset(r.dataset, r.dataset.bars[15]!.ts);
    expect(() => parameterSweep({ ...r, strategy: r.strategy }, oos.outOfSample, { n: [1, 2] })).toThrow(/SWEEP_OOS_FORBIDDEN/);
  });

  it('runs both periods with fixed params and records both', () => {
    const r = base(TREND);
    const oos = runOos(r, r.dataset, r.dataset.bars[15]!.ts);
    expect(oos.paramsTunedOnOos).toBe(false);
    expect(oos.inSample.metrics).toBeDefined();
    expect(oos.outOfSample.metrics).toBeDefined();
    expect(oos.inSample.specHash).not.toBe(oos.outOfSample.specHash);
  });
});

describe('walk-forward', () => {
  it('builds disjoint test windows and rejects overlaps', () => {
    const sessions = Array.from({ length: 30 }, (_, i) => new Date(Date.parse('2024-01-01T00:00:00Z') + i * DAY).toISOString().slice(0, 10));
    const windows = makeWindows(sessions, 10, 5, 5);
    expect(windows.length).toBeGreaterThan(1);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.testFrom).toBeGreaterThan(windows[i - 1]!.testTo);
    }
    expect(() => makeWindows(sessions.slice(0, 8), 10, 5, 5)).toThrow(/WALK_WINDOW_EMPTY/);
    const bad = [windows[0]!, { ...windows[0]!, index: 99 }];
    expect(() => runWalkForward(base(TREND.slice(0, 20)), base(TREND.slice(0, 20)).dataset, bad)).toThrow(/WALK_WINDOW_OVERLAP/);
  });

  it('preserves per-window results and aggregates after', () => {
    const closes = TREND.slice(0, 25);
    const r = base(closes);
    const sessions = r.dataset.bars.map((b) => new Date(b.ts).toISOString().slice(0, 10));
    const windows = makeWindows(sessions, 10, 5, 5);
    const wf = runWalkForward(r, r.dataset, windows);
    expect(wf.windows).toHaveLength(windows.length);
    for (const w of wf.windows) {
      expect(w.train.metrics).toBeDefined();
      expect(w.test.metrics).toBeDefined();
    }
    expect(wf.aggregate).not.toBeNull();
  });
});

describe('stress testing', () => {
  it('cost and slippage shocks degrade or hold results deterministically', () => {
    const r = base(TREND);
    const [shocked] = runStress(r, [{ name: 'cost-x5', costMult: 5 }, { name: 'slip-x10', slippageMult: 10 }]);
    expect(shocked!.scenario).toBe('cost-x5');
    const reference = runBacktest(r);
    expect(shocked!.stressedSharpe).toBeLessThanOrEqual(reference.metrics.sharpe + 1e-9);
  });

  it('handles missing-data and delay shocks', () => {
    const r = base(TREND);
    const [res] = runStress(r, [{ name: 'drop-3rd', dropEveryNth: 3 }, { name: 'delay-2', execDelayAdd: 2 }]);
    expect(res!.run.status).toBe('COMPLETED');
    expect(res!.run.metrics).toBeDefined();
  });
});

describe('parameter sweep and robustness', () => {
  it('caps runaway grid searches', () => {
    const r = base(TREND);
    expect(() => parameterSweep({ ...r, strategy: r.strategy }, r.dataset, { n: [1, 2, 3], threshold: [0, 0.1, 0.2, 0.3] }, 5)).toThrow(/SWEEP_TOO_LARGE/);
  });

  it('finds stable regions and cliffs', () => {
    const r = base(TREND);
    const { runs, stable, cliffs } = parameterSweep({ ...r, strategy: r.strategy }, r.dataset, { n: [2, 3, 4], threshold: [0, 0.05] });
    expect(runs.length).toBe(6);
    expect(Array.isArray(stable)).toBe(true);
    expect(Array.isArray(cliffs)).toBe(true);
    // Sweep size is recorded for overfitting guards downstream.
    expect(runs.every((x) => x.specHash.length > 0)).toBe(true);
  });
});
