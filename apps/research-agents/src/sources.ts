// Source-quality policy + evidence intake filters (configurable, no permanent
// hard-coded trust). Near-duplicate text detection via normalized Jaccard.
import type { EvidenceItem, SourceQualityPolicy, SourceType } from '@aurix/contracts';
import { DEFAULT_SOURCE_QUALITY } from '@aurix/contracts';
import { jaccardSimilarity } from '@aurix/memory-manager';

export function authorityOf(sourceType: SourceType, policy: SourceQualityPolicy = DEFAULT_SOURCE_QUALITY): number {
  return policy.authority[sourceType] ?? policy.authority['other'] ?? 0;
}

export interface FilteredEvidence {
  kept: EvidenceItem[];
  droppedLowAuthority: EvidenceItem[];
  duplicateGroups: { canonical: EvidenceItem; duplicates: EvidenceItem[] }[];
}

function textOf(e: EvidenceItem): string {
  const c = e.content as Record<string, unknown>;
  const parts: string[] = [];
  for (const v of Object.values(c)) {
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number') parts.push(String(v));
  }
  return parts.join(' ');
}

export function filterEvidence(items: EvidenceItem[], policy: SourceQualityPolicy = DEFAULT_SOURCE_QUALITY): FilteredEvidence {
  const kept: EvidenceItem[] = [];
  const droppedLowAuthority: EvidenceItem[] = [];
  const duplicateGroups: { canonical: EvidenceItem; duplicates: EvidenceItem[] }[] = [];
  const seenIds = new Set<string>();
  for (const item of items) {
    if (seenIds.has(item.source_identifier)) {
      const group = duplicateGroups.find((g) => g.canonical.source_identifier === item.source_identifier);
      if (group) group.duplicates.push(item);
      else duplicateGroups.push({ canonical: item, duplicates: [] });
      continue;
    }
    seenIds.add(item.source_identifier);
    if (authorityOf(item.source_type, policy) < policy.minAuthority) {
      droppedLowAuthority.push(item);
      continue;
    }
    const text = textOf(item);
    const match = kept.find((k) => {
      const other = textOf(k);
      return text.length > 0 && other.length > 0 && jaccardSimilarity(text, other) >= policy.duplicateJaccard;
    });
    if (match) {
      const group = duplicateGroups.find((g) => g.canonical.evidence_id === match.evidence_id)
        ?? (() => {
          const g = { canonical: match, duplicates: [] as EvidenceItem[] };
          duplicateGroups.push(g);
          return g;
        })();
      group.duplicates.push(item);
      continue;
    }
    kept.push(item);
  }
  return { kept, droppedLowAuthority, duplicateGroups };
}
