// Shared Phase 2 fixtures: deterministic clock/device, provenance builders.
import { KnowledgeStore } from '../src/index.js';
import { MemoryTables } from '../src/index.js';
import type { KnowledgeLabel, KnowledgeProposalInput, ProvenanceInput, SourceType } from '@aurix/contracts';

let tick = 1_700_000_000_000;
let srcSeq = 0;

export function resetFixtures(): void {
  tick = 1_700_000_000_000;
  srcSeq = 0;
}

export function makeStore(): KnowledgeStore {
  return new KnowledgeStore(new MemoryTables(), { deviceId: 'dev-test', now: () => (tick += 1000) });
}

export function prov(over: Partial<ProvenanceInput> = {}, sourceType: SourceType = 'press'): ProvenanceInput {
  srcSeq += 1;
  return {
    source: 'Test Press',
    source_type: sourceType,
    source_identifier: `test-src-${srcSeq}`,
    observed_at: 1_700_000_000_000,
    agent: 'test-agent',
    evidence_refs: ['ev-1'],
    confidence: 0.8,
    ...over
  };
}

export function nodeInput(
  id: string,
  data: Record<string, unknown>,
  assertion: KnowledgeLabel = 'OBSERVATION',
  provenance?: ProvenanceInput
): KnowledgeProposalInput {
  return {
    assertion,
    ops: [{ op: 'upsert-node', node: { id, kind: 'Company', label: id, data } }],
    provenance: provenance ?? prov(),
    actor: 'test'
  };
}
