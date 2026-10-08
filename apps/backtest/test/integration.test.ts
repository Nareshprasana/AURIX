import { describe, expect, it } from 'vitest';
import { KnowledgeStore, MemoryTables } from '@aurix/knowledge-service';
import { MemoryManager } from '@aurix/memory-manager';
import type { PerformanceMetrics } from '@aurix/strategy';
import { commitExperimentResult, commitHypothesis, decideExperiment, experimentSpecHash, recordStrategyMemory } from '../src/index.js';
import { rocStrategy } from './helpers.js';

const ZERO_METRICS: PerformanceMetrics = {
  total_return: 0, cagr: 0, volatility: 0, max_drawdown: 0, max_dd_duration_bars: 0,
  downside_dev: 0, sharpe: 0, sortino: 0, calmar: 0, trades: 0, win_rate: 0,
  avg_win: 0, avg_loss: 0, profit_factor: 0, turnover: 0, avg_holding_bars: 0,
  worst_day: 0, worst_trade: 0, loss_streak: 0, concentration: 0
};

let tick = 4_000_000_000_000;

function setup() {
  const tables = new MemoryTables();
  const store = new KnowledgeStore(tables, { deviceId: 'dev-int', now: () => tick });
  const memory = new MemoryManager(store);
  return { store, memory };
}

const DEF = () => rocStrategy();

function specInput(version = 'ds-v1') {
  return {
    strategy: DEF(), params: { n: 1 }, datasetVersion: version,
    from_ts: 1, to_ts: 2, cost_model: {}, slippage_model: {}
  };
}

function record(store: KnowledgeStore, hash: string) {
  return recordStrategyMemory(store, {
    specHash: hash, what: 'test:roc', why: 'fixture', dataset: 'ds-v1', params: { n: 1 },
    outcome: 'COMPLETED', failures: [], regimes: [], robustness: 'n/a', status: 'COMPLETED', actor: 'test', now: tick
  });
}

describe('memory-first experiments', () => {
  it('identical spec reuses; changed dataset refreshes; invalidation refreshes', () => {
    const { store, memory } = setup();
    const hash = experimentSpecHash(specInput());
    expect(decideExperiment(memory, hash, { datasetChanged: false, invalidated: false }).decision).toBe('RESEARCH');
    record(store, hash);
    const reuse = decideExperiment(memory, hash, { datasetChanged: false, invalidated: false });
    expect(reuse.decision).toBe('REUSE');
    expect(decideExperiment(memory, hash, { datasetChanged: true, invalidated: false }).decision).toBe('REFRESH');
    expect(decideExperiment(memory, hash, { datasetChanged: false, invalidated: true }).decision).toBe('REFRESH');
  });

  it('strategy memory records are retrievable with rationale', () => {
    const { store, memory } = setup();
    const key = record(store, 'hash-abc');
    const rows = memory.retrieve({ memoryType: 'strategy' }, tick);
    expect(rows.some((r) => (r.record as { key?: string }).key === key)).toBe(true);
  });

  it('experiment results commit as OBSERVATION with evaluation, never FACT', () => {
    const { store } = setup();
    const ref = commitExperimentResult(store, {
      experiment: {
        experiment_id: 'e1', strategy_id: 'test:roc', strategy_version: 1, hypothesis_id: null,
        dataset_id: 'ds', dataset_version: 'ds-v1', params: { n: 1 }, range: { from_ts: 1, to_ts: 2 },
        spec_hash: 'h1', cost_model: 'c', slippage_model: 's', code_version: 'backtest-v1',
        metrics: ZERO_METRICS, status: 'COMPLETED', oos_status: null, walkforward_status: null,
        stress_status: null, sweep_count: 1, parent_experiment_id: null, created_at: tick, actor: 'test'
      },
      metrics: ZERO_METRICS,
      evaluation: 'PROMISING',
      evaluationReasons: ['positive OOS'],
      actor: 'test',
      now: tick
    });
    const node = store.getEntity(ref);
    expect(node?.label_class).toBe('OBSERVATION');
    expect((node?.data as { evaluation: string }).evaluation).toBe('PROMISING');
  });

  it('hypotheses commit as HYPOTHESIS with provenance', () => {
    const { store } = setup();
    const ref = commitHypothesis(store, 'hyp-1', { mechanism: 'm' }, ['ev-1'], 'test', tick);
    expect(store.getEntity(ref)?.label_class).toBe('HYPOTHESIS');
    expect(store.provenanceChain(ref).length).toBeGreaterThan(0);
  });
});
