// @aurix/knowledge-service — deterministic knowledge platform (Phase 2).
// Append-only events; the service owns all writes; agents submit proposals.
// Phase 1 helpers (validateKnowledgeEvent/appendKnowledgeEvent) retained for
// regression compatibility. NOTE: sqlite.ts is intentionally NOT re-exported
// here (vitest cannot load node:sqlite); it is wired by production code and
// proven via scripts/verify-knowledge-sqlite.mjs.
import type { KnowledgeEvent, KnowledgeLabel } from '@aurix/contracts';

const VALID_LABELS: KnowledgeLabel[] = ['FACT', 'OBSERVATION', 'INFERENCE', 'HYPOTHESIS', 'PREDICTION', 'UNKNOWN'];

export function validateKnowledgeEvent(e: KnowledgeEvent): string[] {
  const errors: string[] = [];
  if (!e.id) errors.push('missing id');
  if (!e.entity_ref) errors.push('missing entity_ref');
  if (!VALID_LABELS.includes(e.label_class)) errors.push(`bad label_class: ${e.label_class}`);
  if (!e.evidence_refs || e.evidence_refs.length === 0) errors.push('provenance requires evidence_refs');
  if (!e.actor) errors.push('missing actor');
  if (!e.prev_version || !e.new_version) errors.push('version chain required');
  if (e.label_class === 'FACT' && e.evidence_refs.length < 1) errors.push('FACT requires corroborating evidence');
  return errors;
}

export interface KnowledgeEventStore {
  run(id: string, e: KnowledgeEvent): void;
}

export function appendKnowledgeEvent(e: KnowledgeEvent, exists: (id: string) => boolean, insert: (e: KnowledgeEvent) => void): KnowledgeEvent {
  const errors = validateKnowledgeEvent(e);
  if (errors.length > 0) throw new Error(`invalid knowledge event: ${errors.join('; ')}`);
  if (exists(e.id)) throw new Error(`duplicate knowledge event: ${e.id}`);
  insert(e);
  return e;
}

export { KnowledgeStore, KnowledgeError, SCHEMA_VERSION } from './store.js';
export { MemoryTables, KnowledgeConflictError, TABLES } from './tables.js';
export type { KnowledgeTables, Row } from './tables.js';
export { stableStringify, cyrb53hex } from './hash.js';
export { containsSecretPayload, isSecretString } from './secrets.js';
export { AUTHORITATIVE_SOURCES, MIN_INDEPENDENT_SOURCES, isAuthoritative, downgradeForLlm, canPromoteToFact } from './policy.js';
export { buildExport, verifyExport, sha256Hex } from './export.js';
