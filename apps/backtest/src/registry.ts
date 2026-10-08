// Persistent registries backed by knowledge nodes (Experiment/Strategy kinds).
// Status transitions validated; history via node versions; degradation recorded.
import type { EvaluationLabel, PerformanceMetrics, StrategyDefinition, StrategyStatus } from '@aurix/strategy';
import { STATUS_ORDER } from '@aurix/strategy';
import { KnowledgeStore, containsSecretPayload } from '@aurix/knowledge-service';

const TERMINAL = new Set<StrategyStatus>(['REJECTED', 'RETIRED']);
const FROM_DEGRADED: StrategyStatus[] = ['CANDIDATE', 'REJECTED', 'RETIRED'];

function allowedTransition(from: StrategyStatus, to: StrategyStatus): boolean {
  if (from === to) return true;
  if (TERMINAL.has(from)) return false;
  if (to === 'REJECTED' || to === 'RETIRED') return true;
  if (from === 'DEGRADED') return (FROM_DEGRADED as StrategyStatus[]).includes(to);
  if (to === 'DEGRADED') return true;
  const fi = STATUS_ORDER.indexOf(from);
  const ti = STATUS_ORDER.indexOf(to);
  if (fi === -1 || ti === -1) return false;
  return ti === fi + 1;
}

export interface StoredExperiment {
  experiment_id: string;
  strategy_id: string;
  strategy_version: number;
  hypothesis_id: string | null;
  dataset_id: string;
  dataset_version: string;
  params: Record<string, number>;
  range: { from_ts: number; to_ts: number };
  spec_hash: string;
  cost_model: string;
  slippage_model: string;
  code_version: string;
  metrics: PerformanceMetrics;
  status: string;
  oos_status: string | null;
  walkforward_status: string | null;
  stress_status: string | null;
  sweep_count: number;
  parent_experiment_id: string | null;
  created_at: number;
  actor: string;
}

export class ExperimentRegistry {
  constructor(private knowledge: KnowledgeStore) {}

  record(exp: StoredExperiment): string {
    const id = `experiment:${exp.spec_hash}`;
    const existing = this.knowledge.getEntity(id);
    if (existing) return id; // duplicate spec → reuse existing (no duplicate experiments)
    this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'upsert-node', node: { id, kind: 'Experiment', label: `backtest ${exp.strategy_id}`, data: { ...exp } } }],
      provenance: {
        source: 'backtest-engine', source_type: 'agent', source_identifier: `experiment:${exp.spec_hash}`,
        observed_at: exp.created_at, agent: exp.actor, evidence_refs: [exp.strategy_id, exp.dataset_id], confidence: 1
      },
      actor: exp.actor
    });
    return id;
  }

  findBySpecHash(specHash: string): StoredExperiment | null {
    const node = this.knowledge.getEntity(`experiment:${specHash}`);
    return node ? (node.data as unknown as StoredExperiment) : null;
  }

  listByStrategy(strategyId: string): StoredExperiment[] {
    return this.knowledge.snapshotNodes()
      .filter((n) => n.kind === 'Experiment' && (n.data as { strategy_id?: string }).strategy_id === strategyId)
      .map((n) => n.data as unknown as StoredExperiment)
      .sort((a, b) => a.created_at - b.created_at);
  }
}

export interface DegradationEntry {
  at: number;
  from_sharpe: number;
  to_sharpe: number;
  note: string;
}

export class StrategyRegistry {
  constructor(private knowledge: KnowledgeStore) {}

  nodeId(id: string, version: number): string {
    return `strategy:${id}:v${version}`;
  }

  register(def: StrategyDefinition, actor: string, now: number): string {
    if (containsSecretPayload(def)) throw new Error('SECRET_DETECTED: strategy definitions must not carry credential-shaped material');
    const nodeId = this.nodeId(def.id, def.version);
    const evidence = def.evidence_refs.length > 0 ? def.evidence_refs : [def.id, ...(def.parent ? [`${def.parent.id}:v${def.parent.version}`] : [])];
    this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'upsert-node', node: { id: nodeId, kind: 'Strategy', label: def.name, data: { ...def, degradation_history: [] as DegradationEntry[] } } }],
      provenance: {
        source: 'strategy-registry', source_type: 'agent', source_identifier: nodeId,
        observed_at: now, agent: actor, evidence_refs: evidence, confidence: 1
      },
      actor
    });
    return nodeId;
  }

  get(id: string, version: number): StrategyDefinition | null {
    const node = this.knowledge.getEntity(this.nodeId(id, version));
    return node ? (node.data as unknown as StrategyDefinition) : null;
  }

  list(): { id: string; version: number; status: StrategyStatus; name: string }[] {
    return this.knowledge.snapshotNodes()
      .filter((n) => n.kind === 'Strategy')
      .map((n) => {
        const d = n.data as unknown as StrategyDefinition;
        return { id: d.id, version: d.version, status: d.status, name: d.name };
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  transition(id: string, version: number, to: StrategyStatus, actor: string, now: number): StrategyDefinition {
    const node = this.knowledge.getEntity(this.nodeId(id, version));
    if (!node) throw new Error(`UNKNOWN_STRATEGY: ${id} v${version}`);
    const def = node.data as unknown as StrategyDefinition;
    if (!allowedTransition(def.status, to)) {
      throw new Error(`ILLEGAL_TRANSITION: ${def.status} → ${to}`);
    }
    if (to === 'APPROVED') {
      // Recorded only: no live activation exists in Phase 6 (no wiring, no execution path).
    }
    const updated = { ...def, status: to };
    this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'upsert-node', node: { id: node.id, kind: 'Strategy', label: def.name, data: updated } }],
      provenance: {
        source: 'strategy-registry', source_type: 'agent', source_identifier: node.id,
        observed_at: now, agent: actor, evidence_refs: [node.id], confidence: 1
      },
      actor
    });
    return updated;
  }

  recordDegradation(id: string, version: number, entry: DegradationEntry, actor: string, now: number): void {
    const node = this.knowledge.getEntity(this.nodeId(id, version));
    if (!node) throw new Error(`UNKNOWN_STRATEGY: ${id} v${version}`);
    const def = node.data as unknown as StrategyDefinition & { degradation_history: DegradationEntry[] };
    const history = [...(def.degradation_history ?? []), entry];
    this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'upsert-node', node: { id: node.id, kind: 'Strategy', label: def.name, data: { ...def, status: 'DEGRADED' as StrategyStatus, degradation_history: history } } }],
      provenance: {
        source: 'strategy-registry', source_type: 'agent', source_identifier: node.id,
        observed_at: now, agent: actor, evidence_refs: [node.id], confidence: 1
      },
      actor
    });
  }
}
