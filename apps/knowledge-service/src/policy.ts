// FACT-promotion policy (Phase 2). Pure rules, mirrored in services-python
// (aurix_py/knowledge.py) — the TS copy governs; the Python copy is parity-only.
import type { KnowledgeLabel, SourceType } from '@aurix/contracts';

/** Source types authoritative enough to establish a FACT alone. */
export const AUTHORITATIVE_SOURCES: SourceType[] = ['exchange-filing', 'regulator', 'audited-statement'];

/** Independent sources required for non-authoritative FACT promotion. */
export const MIN_INDEPENDENT_SOURCES = 2;

export function isAuthoritative(sourceType: SourceType): boolean {
  return AUTHORITATIVE_SOURCES.includes(sourceType);
}

/**
 * LLM-derived input defaults to non-FACT. A bare LLM FACT claim without
 * corroboration is downgraded (never silently promoted).
 */
export function downgradeForLlm(assertion: KnowledgeLabel, sourceType: SourceType): KnowledgeLabel {
  if (assertion === 'FACT' && sourceType === 'llm') return 'INFERENCE';
  return assertion;
}

/** Non-authoritative FACT candidacy needs corroboration from other sources. */
export function canPromoteToFact(sourceType: SourceType, independentSources: number): boolean {
  if (isAuthoritative(sourceType)) return true;
  return independentSources >= MIN_INDEPENDENT_SOURCES;
}
