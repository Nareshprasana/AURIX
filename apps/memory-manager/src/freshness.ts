// Per-domain freshness policies. Freshness ≠ truth ≠ confidence ≠ validation:
// an old FACT stays a FACT; a fresh OBSERVATION can still be wrong.
import type { Freshness } from '@aurix/market-data';

export type MemoryFreshness = Freshness;
export type MemoryDomain =
  | 'price' | 'quote' | 'intraday' | 'fundamentals' | 'corporate-event'
  | 'static' | 'research' | 'default';

export interface FreshnessPolicy {
  domain: MemoryDomain;
  freshMs: number;
  agingMs: number;
}

export const MEMORY_FRESHNESS: Record<MemoryDomain, { freshMs: number; agingMs: number }> = {
  price: { freshMs: 60_000, agingMs: 300_000 },
  quote: { freshMs: 60_000, agingMs: 300_000 },
  intraday: { freshMs: 15 * 60_000, agingMs: 60 * 60_000 },
  fundamentals: { freshMs: 90 * 24 * 3600_000, agingMs: 180 * 24 * 3600_000 },
  'corporate-event': { freshMs: 24 * 3600_000, agingMs: 7 * 24 * 3600_000 },
  static: { freshMs: 365 * 24 * 3600_000, agingMs: 730 * 24 * 3600_000 },
  research: { freshMs: 7 * 24 * 3600_000, agingMs: 30 * 24 * 3600_000 },
  default: { freshMs: 24 * 3600_000, agingMs: 7 * 24 * 3600_000 }
};

export function classifyMemoryAge(
  domain: MemoryDomain,
  ageMs: number | null,
  policy: Record<MemoryDomain, { freshMs: number; agingMs: number }> = MEMORY_FRESHNESS
): MemoryFreshness {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return 'UNKNOWN';
  const p = policy[domain] ?? policy['default']!;
  if (ageMs <= p.freshMs) return 'FRESH';
  if (ageMs <= p.agingMs) return 'AGING';
  return 'STALE';
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'in', 'on', 'to', 'is', 'are']);

export function normalizeText(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

/** Token-Jaccard similarity over normalized bags. Deterministic; flagged heuristic by callers. */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(normalizeText(a));
  const setB = new Set(normalizeText(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export function normalizeTaskKey(subject: string, objective: string, scope: string): string {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${norm(subject)}|${norm(objective)}|${norm(scope)}`;
}
