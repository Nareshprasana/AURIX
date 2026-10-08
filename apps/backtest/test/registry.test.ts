import { describe, expect, it, beforeEach } from 'vitest';
import { KnowledgeStore, MemoryTables } from '@aurix/knowledge-service';
import { ExperimentRegistry, StrategyRegistry } from '../src/index.js';
import { rocStrategy } from './helpers.js';

let tick = 3_000_000_000_000;

function setup() {
  const store = new KnowledgeStore(new MemoryTables(), { deviceId: 'dev-reg', now: () => tick });
  return { store, experiments: new ExperimentRegistry(store), strategies: new StrategyRegistry(store) };
}

function exp(over: Record<string, unknown> = {}) {
  return {
    experiment_id: 'exp-1',
    strategy_id: 'test:roc',
    strategy_version: 1,
    hypothesis_id: null,
    dataset_id: 'ds',
    dataset_version: 'ds-v1',
    params: { n: 1 },
    range: { from_ts: 1, to_ts: 2 },
    spec_hash: `hash-${Math.random()}`,
    cost_model: 'c',
    slippage_model: 's',
    code_version: 'backtest-v1',
    metrics: {},
    status: 'COMPLETED',
    oos_status: null,
    walkforward_status: null,
    stress_status: null,
    sweep_count: 1,
    parent_experiment_id: null,
    created_at: tick,
    actor: 'test',
    ...over
  } as never;
}

describe('experiment registry', () => {
  it('records experiments and reuses duplicate specs', () => {
    const { experiments } = setup();
    const id1 = experiments.record(exp({ spec_hash: 'dup' }));
    const id2 = experiments.record(exp({ spec_hash: 'dup' }));
    expect(id1).toBe(id2);
    expect(experiments.findBySpecHash('dup')?.strategy_id).toBe('test:roc');
    expect(experiments.listByStrategy('test:roc')).toHaveLength(1);
  });

  it('tracks lineage across related experiments', () => {
    const { experiments } = setup();
    experiments.record(exp({ spec_hash: 'parent' }));
    experiments.record(exp({ spec_hash: 'child', parent_experiment_id: 'parent' }));
    expect(experiments.listByStrategy('test:roc')).toHaveLength(2);
  });
});

describe('strategy registry lifecycle', () => {
  it('registers, lists and transitions forward only', () => {
    const { strategies } = setup();
    const def = rocStrategy();
    strategies.register({ ...def, id: 'strat:a', status: 'HYPOTHESIS' }, 'test', tick);
    expect(strategies.list().map((s) => s.id)).toContain('strat:a');
    const next = strategies.transition('strat:a', 1, 'CANDIDATE', 'test', tick);
    expect(next.status).toBe('CANDIDATE');
    expect(() => strategies.transition('strat:a', 1, 'OOS_VALIDATED', 'test', tick)).toThrow(/ILLEGAL_TRANSITION/);
  });

  it('terminal states and degradation are recorded with history', () => {
    const { store, strategies } = setup();
    const def = rocStrategy();
    strategies.register({ ...def, id: 'strat:b', status: 'CANDIDATE' }, 'test', tick);
    strategies.transition('strat:b', 1, 'REJECTED', 'test', tick);
    expect(() => strategies.transition('strat:b', 1, 'CANDIDATE', 'test', tick)).toThrow(/ILLEGAL_TRANSITION/);
    strategies.register({ ...def, id: 'strat:c', status: 'BACKTESTED' }, 'test', tick);
    strategies.recordDegradation('strat:c', 1, { at: tick, from_sharpe: 1.2, to_sharpe: 0.3, note: 'oos decay' }, 'test', tick);
    const node = store.getEntity('strategy:strat:c:v1');
    expect((node?.data as { status: string }).status).toBe('DEGRADED');
    expect(((node?.data as { degradation_history: unknown[] }).degradation_history)).toHaveLength(1);
    expect(store.entityHistory('strategy:strat:c:v1').length).toBeGreaterThanOrEqual(2);
  });

  it('APPROVED is recordable but activates nothing live', () => {
    const { strategies } = setup();
    const def = rocStrategy();
    strategies.register({ ...def, id: 'strat:d', status: 'PAPER_ELIGIBLE' }, 'test', tick);
    const approved = strategies.transition('strat:d', 1, 'APPROVED', 'governance', tick);
    expect(approved.status).toBe('APPROVED');
  });

  it('rejects secrets in strategy definitions', () => {
    const { strategies } = setup();
    const def = rocStrategy();
    expect(() => strategies.register({ ...def, id: 'strat:e', description: 'uses api_key=SECRET' }, 'test', tick)).toThrow(/SECRET/);
  });
});
