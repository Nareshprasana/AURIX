import { KnowledgeStore, MemoryTables } from '@aurix/knowledge-service';
import type { KnowledgeLabel, KnowledgeProposalInput } from '@aurix/contracts';
import { MemoryManager } from '../src/index.js';

export const NOW = 1_800_000_000_000;

let tick = NOW;
let seq = 0;

export function resetHelpers(): void {
  tick = NOW;
  seq = 0;
}

export function makeManager(): { store: KnowledgeStore; manager: MemoryManager } {
  const store = new KnowledgeStore(new MemoryTables(), { deviceId: 'dev-mem', now: () => tick });
  return { store, manager: new MemoryManager(store) };
}

export function advance(ms: number): number {
  tick += ms;
  return tick;
}

export function prov(over: Partial<KnowledgeProposalInput['provenance']> = {}): KnowledgeProposalInput['provenance'] {
  seq += 1;
  return {
    source: 'mem-test', source_type: 'press', source_identifier: `mem-src-${seq}`,
    observed_at: tick, agent: 'mem-agent', evidence_refs: [`mem-ev-${seq}`], confidence: 0.8, ...over
  };
}

export function commitNode(
  store: KnowledgeStore,
  id: string,
  data: Record<string, unknown>,
  assertion: KnowledgeLabel = 'OBSERVATION',
  provenance?: KnowledgeProposalInput['provenance']
): void {
  store.proposeValidateCommit({
    assertion,
    ops: [{ op: 'upsert-node', node: { id, kind: 'Company', label: id, data } }],
    provenance: provenance ?? prov(),
    actor: 'mem-test'
  });
}

export function commitMemory(
  store: KnowledgeStore,
  category: 'semantic' | 'episodic' | 'trading-experience' | 'strategy' | 'agent' | 'evidence',
  key: string,
  content: Record<string, unknown>,
  assertion: KnowledgeLabel = 'OBSERVATION',
  provenance?: KnowledgeProposalInput['provenance']
): void {
  store.proposeValidateCommit({
    assertion,
    ops: [{ op: 'put-memory', memory: { category, key, content } }],
    provenance: provenance ?? prov(),
    actor: 'mem-test'
  });
}
