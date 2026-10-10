// Research-to-knowledge ingestion (P2-1): import reviewed research-agent
// records (questions/hypotheses/conclusions) into the authoritative knowledge
// system through the EXISTING propose/validate/commit path. No new store,
// no validation bypass, no promotion.
//
// Mapping (documented, stable):
//   question   -> OBSERVATION memory (observed: this inquiry was raised)
//   hypothesis -> HYPOTHESIS memory (testable claim + falsification)
//   conclusion -> OBSERVATION memory (measured outcome, incl. negatives)
// INFERENCE is reserved for future interpreted syntheses and never written
// here. FACT is never asserted by this module (static test enforces it).
//
// Idempotency: deterministic key `research:{record-id}` + deterministic
// content (record's own timestamps only, never wall-clock). Re-ingestion hits
// the existing DUPLICATE_MEMORY rejection and is recorded as skipped, so
// retries and restarts cannot duplicate knowledge.
import type {
  KnowledgeLabel,
  KnowledgeProposalInput,
  MemoryCategory
} from '@aurix/contracts';
import type { KnowledgeStore } from './index.js';

export const RESEARCH_MEMORY_CATEGORY: MemoryCategory = 'strategy';
export const RESEARCH_AGENT_ACTOR = 'research-agent';
export const RESEARCH_INGEST_VERSION = 'research-ingest-v1';

export interface ResearchRecordInput {
  record: 'question' | 'hypothesis' | 'conclusion' | string;
  id?: string;
  experiment_id?: string;
  created_at?: number;
  [key: string]: unknown;
}

export interface IngestSummary {
  imported: string[];
  skipped: { index: number; id: string | null; reason: string }[];
}

const LABEL_BY_RECORD: Record<string, KnowledgeLabel> = {
  question: 'OBSERVATION',
  hypothesis: 'HYPOTHESIS',
  conclusion: 'OBSERVATION'
};

function recordKey(kind: string, id: string): string {
  return `research:${kind}:${id}`;
}

export function buildResearchProposal(record: ResearchRecordInput): KnowledgeProposalInput {
  if (!record || typeof record !== 'object') {
    throw new Error('RESEARCH_INGEST_MALFORMED: record must be an object');
  }
  const kind = record.record;
  if (kind !== 'question' && kind !== 'hypothesis' && kind !== 'conclusion') {
    throw new Error(`RESEARCH_INGEST_UNSUPPORTED: ${String(kind)}`);
  }
  const id = record.id ?? (kind === 'conclusion' ? record.experiment_id : undefined);
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('RESEARCH_INGEST_MALFORMED: missing record id');
  }
  const createdAt = typeof record.created_at === 'number' && Number.isFinite(record.created_at)
    ? record.created_at
    : 0;
  if (createdAt <= 0) {
    throw new Error('RESEARCH_INGEST_MALFORMED: missing created_at');
  }
  // Deterministic content: only fields from the record itself, never wall-clock.
  const { record: _k, ...rest } = record;
  const content: Record<string, unknown> = {
    kind,
    id,
    ingest_version: RESEARCH_INGEST_VERSION,
    ...rest
  };
  const evidence: string[] = [];
  const pushRef = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) evidence.push(v);
  };
  pushRef(record.experiment_id);
  if (Array.isArray(record.supporting_evidence)) record.supporting_evidence.forEach(pushRef);
  const basedOn = (record as { based_on?: unknown }).based_on;
  if (Array.isArray(basedOn)) basedOn.forEach(pushRef);
  return {
    assertion: LABEL_BY_RECORD[kind] as KnowledgeLabel,
    ops: [{ op: 'put-memory', memory: { category: RESEARCH_MEMORY_CATEGORY, key: recordKey(kind, id), content } }],
    provenance: {
      source: 'aurix-research-agent',
      source_type: 'agent',
      source_identifier: `research:${id}`,
      observed_at: createdAt,
      agent: RESEARCH_AGENT_ACTOR,
      evidence_refs: evidence,
      confidence: kind === 'hypothesis' ? 0.5 : 1.0
    },
    actor: RESEARCH_AGENT_ACTOR
  };
}

/** Import a batch. Malformed/duplicate records are collected, never fatal. */
export function ingestResearchRecords(store: KnowledgeStore, records: unknown[]): IngestSummary {
  const summary: IngestSummary = { imported: [], skipped: [] };
  records.forEach((raw, index) => {
    let proposal: KnowledgeProposalInput;
    try {
      proposal = buildResearchProposal(raw as ResearchRecordInput);
    } catch (err) {
      summary.skipped.push({
        index, id: (raw as { id?: unknown })?.id as string ?? null,
        reason: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    try {
      store.proposeValidateCommit(proposal);
      const key = (proposal.ops[0] as { memory: { key: string } }).memory.key;
      summary.imported.push(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const key = (proposal.ops[0] as { memory: { key: string } }).memory.key;
      // An identical proposal already COMMITTED throws an empty REJECTED;
      // confirm against stored memories before calling it a duplicate.
      let alreadyStored = /DUPLICATE_MEMORY/.test(message);
      if (!alreadyStored) {
        try {
          alreadyStored = store.queryMemories(RESEARCH_MEMORY_CATEGORY, key).length > 0;
        } catch {
          alreadyStored = false;
        }
      }
      summary.skipped.push({
        index, id: (raw as { id?: unknown })?.id as string ?? null,
        reason: alreadyStored ? `duplicate (already imported): ${message}` : message
      });
    }
  });
  return summary;
}
