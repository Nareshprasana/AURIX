import { KnowledgeStore, MemoryTables } from '@aurix/knowledge-service';
import type { EvidenceItem } from '@aurix/contracts';
import { MemoryManager } from '@aurix/memory-manager';
import { normalizeBar } from '@aurix/market-data';
import type { CanonicalBar } from '@aurix/market-data';
import { ResearchOrchestrator } from '../src/index.js';

export const NOW = 1_900_000_000_000;

let tick = NOW;
let seq = 0;

export function resetResearch(): void {
  tick = NOW;
  seq = 0;
}

export function makeResearch(): { store: KnowledgeStore; memory: MemoryManager; orch: ResearchOrchestrator } {
  const store = new KnowledgeStore(new MemoryTables(), { deviceId: 'dev-research', now: () => tick });
  const memory = new MemoryManager(store);
  const orch = new ResearchOrchestrator(store, memory);
  return { store, memory, orch };
}

export function advance(ms: number): void {
  tick += ms;
}

export function metricEv(metric: string, value: number, period: string, id: string, sourceType = 'press'): EvidenceItem {
  seq += 1;
  return {
    evidence_id: `ev-${id}`,
    kind: 'financial-metric',
    subject: 'company:TCS',
    content: { metric, value, period },
    source: 'filing-fixture',
    source_type: sourceType as EvidenceItem['source_type'],
    source_identifier: `filing-${id}`,
    observed_at: tick,
    retrieved_at: tick,
    confidence: 0.85
  };
}

export function textEv(id: string, title: string, text: string): EvidenceItem {
  return {
    evidence_id: `ev-${id}`,
    kind: 'text',
    subject: 'company:TCS',
    content: { title, text },
    source: 'press-fixture',
    source_type: 'press',
    source_identifier: `press-${id}`,
    observed_at: tick,
    retrieved_at: tick,
    confidence: 0.6
  };
}

export function macroEv(indicator: string, value: number, period: string, id: string, extra: Record<string, unknown> = {}): EvidenceItem {
  return {
    evidence_id: `ev-${id}`,
    kind: 'macro-indicator',
    subject: 'macro:IN',
    content: { indicator, value, period, ...extra },
    source: 'stat-fixture',
    source_type: 'regulator',
    source_identifier: `stat-${id}`,
    observed_at: tick,
    retrieved_at: tick,
    confidence: 0.9
  };
}

export function valuationInput(metric: string, value: number, id: string): EvidenceItem {
  return {
    evidence_id: `ev-${id}`,
    kind: 'valuation-input',
    subject: 'company:TCS',
    content: { metric, value },
    source: 'fixture',
    source_type: 'market-data',
    source_identifier: `mkt-${id}`,
    observed_at: tick,
    retrieved_at: tick,
    confidence: 0.9
  };
}

export function barAt(ts: number, close: number, i: number): CanonicalBar {
  return normalizeBar({
    instrument_id: 'TCS', exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: 'TCS',
    ts, tz: 'Asia/Kolkata', timeframe: '1D',
    open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 + i
  }, 'stub');
}

export function bars(n: number, start = 100): CanonicalBar[] {
  const out: CanonicalBar[] = [];
  for (let i = 0; i < n; i++) out.push(barAt(NOW - (n - i) * 86_400_000, start + i, i));
  return out;
}
