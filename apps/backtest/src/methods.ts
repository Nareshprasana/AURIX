// OOS splits, walk-forward windows, stress scenarios, parameter sweeps with
// robustness analysis. Methodology artifacts are persisted per window/run.
import type { BacktestState, PerformanceMetrics, StrategyDefinition } from '@aurix/strategy';
import { computeMetrics, FAMILY_PRESETS } from '@aurix/strategy';
import type { BacktestDataset } from './datasets.js';
import { buildDataset } from './datasets.js';
import type { BacktestRequest, BacktestRun } from './engine.js';
import { runBacktest } from './engine.js';
import { TradingCalendar } from '@aurix/strategy';

export interface DateSplit {
  inSample: BacktestDataset;
  outOfSample: BacktestDataset;
  splitTs: number;
}

export function splitDataset(dataset: BacktestDataset, splitTs: number): DateSplit {
  const inBars = dataset.bars.filter((b) => b.ts < splitTs);
  const oosBars = dataset.bars.filter((b) => b.ts >= splitTs);
  if (inBars.length === 0 || oosBars.length === 0) {
    throw new Error('OOS_SPLIT_EMPTY: split produces an empty side');
  }
  const base = {
    timeframe: dataset.timeframe,
    adjustments: dataset.adjustments,
    dividends: dataset.dividends,
    fundamentals: dataset.fundamentals,
    events: dataset.events,
    universe: dataset.universe,
    calendar_version: dataset.calendar_version,
    source: dataset.source
  };
  return {
    inSample: buildDataset({ ...base, id: `${dataset.id}:is`, bars: inBars }),
    outOfSample: buildDataset({ ...base, id: `${dataset.id}:oos`, bars: oosBars }),
    splitTs
  };
}

export interface OosResult {
  inSample: BacktestRun;
  outOfSample: BacktestRun;
  splitTs: number;
  paramsTunedOnOos: boolean;
}

/** OOS evaluation with FIXED params. The sweep API only accepts in-sample data (enforced). */
export function runOos(base: Omit<BacktestRequest, 'dataset'>, dataset: BacktestDataset, splitTs: number): OosResult {
  const split = splitDataset(dataset, splitTs);
  const inSample = runBacktest({ ...base, dataset: split.inSample });
  const outOfSample = runBacktest({ ...base, dataset: split.outOfSample });
  return { inSample, outOfSample, splitTs, paramsTunedOnOos: false };
}

export interface WalkWindow {
  index: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
}

export function makeWindows(sessions: string[], trainBars: number, testBars: number, stepBars: number): WalkWindow[] {
  if (trainBars <= 0 || testBars <= 0 || stepBars <= 0) throw new Error('WALK_WINDOW_INVALID: positive sizes required');
  const windows: WalkWindow[] = [];
  let start = 0;
  let index = 0;
  while (start + trainBars + testBars <= sessions.length) {
    const trainFrom = Date.parse(`${sessions[start]}T00:00:00Z`);
    const trainTo = Date.parse(`${sessions[start + trainBars - 1]}T23:59:59Z`);
    const testFrom = Date.parse(`${sessions[start + trainBars]}T00:00:00Z`);
    const testTo = Date.parse(`${sessions[start + trainBars + testBars - 1]}T23:59:59Z`);
    windows.push({ index: index++, trainFrom, trainTo, testFrom, testTo });
    start += stepBars;
  }
  if (windows.length === 0) throw new Error('WALK_WINDOW_EMPTY: range too short for windows');
  return windows;
}

function sliceDataset(dataset: BacktestDataset, fromTs: number, toTs: number, suffix: string): BacktestDataset {
  return buildDataset({
    id: `${dataset.id}:${suffix}`,
    timeframe: dataset.timeframe,
    bars: dataset.bars.filter((b) => b.ts >= fromTs && b.ts <= toTs),
    adjustments: dataset.adjustments,
    dividends: dataset.dividends.filter((d) => d.ex_ts >= fromTs && d.ex_ts <= toTs),
    fundamentals: dataset.fundamentals,
    events: dataset.events,
    universe: dataset.universe,
    calendar_version: dataset.calendar_version,
    source: dataset.source
  });
}

export interface WalkForwardResult {
  windows: { window: WalkWindow; train: BacktestRun; test: BacktestRun }[];
  aggregate: PerformanceMetrics | null;
}

/** Fixed params per strategy version across windows (no per-window optimization in Phase 6). */
export function runWalkForward(
  base: Omit<BacktestRequest, 'dataset'>,
  dataset: BacktestDataset,
  windows: WalkWindow[]
): WalkForwardResult {
  // Test ranges must be disjoint (no overlap leakage).
  const sorted = [...windows].sort((a, b) => a.testFrom - b.testFrom);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.testFrom <= sorted[i - 1]!.testTo) {
      throw new Error('WALK_WINDOW_OVERLAP: test ranges must be disjoint');
    }
  }
  const out: WalkForwardResult = { windows: [], aggregate: null };
  const testEquity: number[] = [];
  const testTrades: BacktestRun['trades'] = [];
  for (const w of windows) {
    const train = runBacktest({ ...base, dataset: sliceDataset(dataset, w.trainFrom, w.trainTo, `w${w.index}-train`) });
    const test = runBacktest({ ...base, dataset: sliceDataset(dataset, w.testFrom, w.testTo, `w${w.index}-test`) });
    out.windows.push({ window: w, train, test });
    for (const p of test.equity) testEquity.push(p.equity);
    for (const t of test.trades) testTrades.push(t);
  }
  if (testEquity.length > 0) {
    out.aggregate = computeMetrics(testEquity, testTrades, base.initial_cash, 252);
  }
  return out;
}

export interface StressScenario {
  name: string;
  costMult?: number;
  slippageMult?: number;
  spreadAddBps?: number;
  participationMult?: number;
  execDelayAdd?: number;
  dropEveryNth?: number;
}

export interface StressResult {
  scenario: string;
  run: BacktestRun;
  baseSharpe: number;
  stressedSharpe: number;
  baseDd: number;
  stressedDd: number;
}

export function applyStress(base: BacktestRequest, scenario: StressScenario): BacktestRequest {
  const strategy = {
    ...base.strategy,
    cost_model: {
      ...base.strategy.cost_model,
      brokerage_bps: base.strategy.cost_model.brokerage_bps * (scenario.costMult ?? 1),
      exchange_bps: base.strategy.cost_model.exchange_bps * (scenario.costMult ?? 1),
      taxes_bps: base.strategy.cost_model.taxes_bps * (scenario.costMult ?? 1)
    },
    slippage_model: {
      ...base.strategy.slippage_model,
      base_bps: base.strategy.slippage_model.base_bps * (scenario.slippageMult ?? 1)
    },
    liquidity: {
      ...base.strategy.liquidity,
      max_participation: base.strategy.liquidity.max_participation * (scenario.participationMult ?? 1),
      max_spread_bps: base.strategy.liquidity.max_spread_bps + (scenario.spreadAddBps ?? 0)
    }
  };
  let dataset = base.dataset;
  const dropEvery = scenario.dropEveryNth ?? 0;
  if (dropEvery > 1) {
    const every = dropEvery;
    const kept = dataset.bars.filter((_, i) => (i + 1) % every !== 0);
    dataset = buildDataset({
      id: `${dataset.id}:stress-drop`, timeframe: dataset.timeframe, bars: kept,
      adjustments: dataset.adjustments, dividends: dataset.dividends, fundamentals: dataset.fundamentals,
      events: dataset.events, universe: dataset.universe, calendar_version: dataset.calendar_version, source: dataset.source
    });
  }
  return {
    ...base,
    dataset,
    strategy,
    exec_delay_bars: (base.exec_delay_bars ?? 1) + (scenario.execDelayAdd ?? 0)
  };
}

export function runStress(base: BacktestRequest, scenarios: StressScenario[]): StressResult[] {
  const reference = runBacktest(base);
  return scenarios.map((scenario) => {
    const run = runBacktest(applyStress(base, scenario));
    return {
      scenario: scenario.name,
      run,
      baseSharpe: reference.metrics.sharpe,
      stressedSharpe: run.metrics.sharpe,
      baseDd: reference.metrics.max_drawdown,
      stressedDd: run.metrics.max_drawdown
    };
  });
}

export interface SweepRun {
  params: Record<string, number>;
  metrics: PerformanceMetrics;
  status: BacktestState['status'];
  specHash: string;
}

export const MAX_SWEEP_RUNS = 125;

export function parameterSweep(
  base: Omit<BacktestRequest, 'dataset'> & { strategy: StrategyDefinition },
  dataset: BacktestDataset,
  grid: Record<string, number[]>,
  maxRuns = MAX_SWEEP_RUNS
): { runs: SweepRun[]; stable: { param: string; region: [number, number] }[]; cliffs: { param: string; at: number; drop: number }[] } {
  const keys = Object.keys(grid).sort();
  const combos: Record<string, number>[] = [{}];
  for (const k of keys) {
    const values = grid[k] ?? [];
    const next: Record<string, number>[] = [];
    for (const c of combos) {
      for (const v of values) next.push({ ...c, [k]: v });
    }
    combos.splice(0, combos.length, ...next);
  }
  if (combos.length > maxRuns) {
    throw new Error(`SWEEP_TOO_LARGE: ${combos.length} runs > cap ${maxRuns} (bounded local compute)`);
  }
  // Sweep datasets must be in-sample only: refuse ranges marked OOS.
  if (dataset.id.includes(':oos')) {
    throw new Error('SWEEP_OOS_FORBIDDEN: parameter search runs on in-sample data only');
  }
  const strategy = { ...base.strategy };
  const presetName = strategy.family_preset;
  const preset = presetName ? FAMILY_PRESETS[presetName] : undefined;
  if (!preset) {
    throw new Error('SWEEP_NEEDS_PRESET: swept strategies must record their family_preset for condition rebuilds');
  }
  const runs: SweepRun[] = combos.map((params) => {
    const merged = { ...strategy.params, ...params };
    for (const [k, b] of Object.entries(preset.bounds)) {
      const v = merged[k];
      if (v === undefined || v < b[0] || v > b[1]) throw new Error(`SWEEP_OUT_OF_BOUNDS: ${k}=${v}`);
    }
    const conditions = preset.build(merged);
    const def = {
      ...strategy,
      params: merged,
      param_bounds: { ...preset.bounds },
      entry_long: conditions.entry_long,
      entry_short: conditions.entry_short,
      exit: conditions.exit
    };
    const run = runBacktest({ ...base, strategy: def, dataset });
    return { params, metrics: run.metrics, status: run.status, specHash: run.specHash };
  });
  const stable: { param: string; region: [number, number] }[] = [];
  const cliffs: { param: string; at: number; drop: number }[] = [];
  for (const k of keys) {
    const byParam = runs
      .filter((r) => r.status === 'COMPLETED')
      .sort((a, b) => (a.params[k] ?? 0) - (b.params[k] ?? 0));
    if (byParam.length < 3) continue;
    const sharpes = byParam.map((r) => r.metrics.sharpe);
    const best = Math.max(...sharpes);
    if (best <= 0) continue;
    let runStart = 0;
    for (let i = 0; i <= byParam.length; i++) {
      const inRegion = i < byParam.length && sharpes[i]! >= 0.8 * best;
      if (!inRegion && i > runStart) {
        const region = byParam.slice(runStart, i);
        if (region.length >= 2) {
          stable.push({ param: k, region: [region[0]!.params[k]!, region[region.length - 1]!.params[k]!] });
        }
        runStart = i;
      } else if (!inRegion) {
        runStart = i;
      }
      if (i > 0 && i < byParam.length) {
        const drop = sharpes[i - 1]! - sharpes[i]!;
        if (drop > 0.5 * Math.max(best, 0.01)) cliffs.push({ param: k, at: byParam[i]!.params[k]!, drop });
      }
    }
  }
  return { runs, stable, cliffs };
}
