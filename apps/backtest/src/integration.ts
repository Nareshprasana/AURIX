// Memory-first experiment lookup, strategy-memory records, and knowledge
// commits (OBSERVATION/EXPERIMENT-RESULT/INFERENCE/HYPOTHESIS — never FACT).
import type { EvaluationLabel, PerformanceMetrics, StrategyDefinition } from '@aurix/strategy';
import { KnowledgeStore, cyrb53hex, stableStringify } from '@aurix/knowledge-service';
import { MemoryManager } from '@aurix/memory-manager';
import type { BacktestRun } from './engine.js';
import type { StoredExperiment } from './registry.js';

export function experimentSpecHash(input: {
  strategy: StrategyDefinition;
  params: Record<string, number>;
  datasetVersion: string;
  from_ts: number;
  to_ts: number;
  cost_model: unknown;
  slippage_model: unknown;
}): string {
  return cyrb53hex(stableStringify({
    strategy: `${input.strategy.id}:v${input.strategy.version}`,
    params: input.params,
    dataset: input.datasetVersion,
    range: [input.from_ts, input.to_ts],
    cost: input.cost_model,
    slippage: input.slippage_model,
    code: 'backtest-v1'
  }));
}

export type ExperimentReuse = 'REUSE' | 'REFRESH' | 'RESEARCH';

/** Memory-first: identical spec + dataset → REUSE; changed inputs → rerun. */
export function decideExperiment(
  memory: MemoryManager,
  specHash: string,
  changed: { datasetChanged: boolean; invalidated: boolean }
): { decision: ExperimentReuse; basis: string; prior: unknown } {
  const prior = memory.retrieve({ topic: `experiment:${specHash}` });
  if (!changed.datasetChanged && !changed.invalidated && prior.length > 0) {
    return { decision: 'REUSE', basis: `equivalent experiment ${specHash} already recorded`, prior: prior[0] };
  }
  if (changed.invalidated) return { decision: 'REFRESH', basis: 'assumptions invalidated by new event/evidence', prior: prior[0] ?? null };
  if (changed.datasetChanged) return { decision: 'REFRESH', basis: 'dataset version changed', prior: prior[0] ?? null };
  return { decision: 'RESEARCH', basis: 'no equivalent experiment recorded', prior: null };
}

export function recordStrategyMemory(
  knowledge: KnowledgeStore,
  input: {
    specHash: string;
    what: string;
    why: string;
    dataset: string;
    params: Record<string, number>;
    outcome: string;
    failures: string[];
    regimes: string[];
    robustness: string;
    status: string;
    actor: string;
    now?: number;
  }
): string {
  const now = input.now ?? Date.now();
  const { specHash, actor, ...rest } = input;
  const { event } = knowledge.proposeValidateCommit({
    assertion: 'OBSERVATION',
    ops: [{ op: 'put-memory', memory: { category: 'strategy', key: `experiment:${specHash}`, content: { ...rest, spec_hash: specHash, domain: 'research', topic: `experiment:${specHash}`, entity: rest.what } } }],
    provenance: {
      source: 'strategy-lab', source_type: 'agent', source_identifier: `strategy-memory:${specHash}`,
      observed_at: now, agent: actor, evidence_refs: [specHash], confidence: 1
    },
    actor
  });
  void event;
  return `experiment:${specHash}`;
}

export function commitExperimentResult(
  knowledge: KnowledgeStore,
  input: {
    experiment: StoredExperiment;
    metrics: PerformanceMetrics;
    evaluation: EvaluationLabel;
    evaluationReasons: string[];
    actor: string;
    now?: number;
  }
): string {
  const now = input.now ?? Date.now();
  // EXPERIMENT RESULT is an observation of history, never a FACT about the future.
  const { event } = knowledge.proposeValidateCommit({
    assertion: 'OBSERVATION',
    ops: [{ op: 'upsert-node', node: { id: `experiment-result:${input.experiment.spec_hash}`, kind: 'Experiment', label: `result ${input.experiment.strategy_id}`, data: { experiment_id: input.experiment.spec_hash, strategy: input.experiment.strategy_id, metrics: input.metrics, evaluation: input.evaluation, reasons: input.evaluationReasons } } }],
    provenance: {
      source: 'backtest-engine', source_type: 'agent', source_identifier: `experiment:${input.experiment.spec_hash}`,
      observed_at: now, agent: input.actor, evidence_refs: [input.experiment.strategy_id, input.experiment.dataset_id], confidence: 1
    },
    actor: input.actor
  });
  return event.entity_ref;
}

export function commitHypothesis(
  knowledge: KnowledgeStore,
  hypothesisId: string,
  data: Record<string, unknown>,
  evidenceRefs: string[],
  actor: string,
  now = Date.now()
): string {
  const { event } = knowledge.proposeValidateCommit({
    assertion: 'HYPOTHESIS',
    ops: [{ op: 'upsert-node', node: { id: `hypothesis:${hypothesisId}`, kind: 'Observation', label: `hypothesis ${hypothesisId}`, data } }],
    provenance: {
      source: 'strategy-lab', source_type: 'agent', source_identifier: `hypothesis:${hypothesisId}`,
      observed_at: now, agent: actor, evidence_refs: evidenceRefs, confidence: 0.5
    },
    actor
  });
  return event.entity_ref;
}
