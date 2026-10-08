// Minimal deterministic event foundation: schema, corporate-action mapping,
// invalidation topic rules, and a fixture StubProvider (interfaces only otherwise).
import type {
  BarProvider,
  CanonicalBar,
  CanonicalQuote,
  CorporateActionProvider,
  CorporateActionRecord,
  InstrumentProvider,
  InstrumentRef,
  MarketEvent,
  MarketEventType,
  QuoteProvider
} from './types.js';

export const EVENT_TYPES: MarketEventType[] = [
  'earnings', 'dividend', 'split', 'bonus', 'rights', 'buyback',
  'merger', 'demerger', 'promoter-action', 'pledging', 'management-change',
  'regulatory', 'macro', 'custom'
];

/** Memory topics invalidated by each event type (targeted refresh, never delete). */
export function invalidationTopicsFor(eventType: MarketEventType): string[] {
  switch (eventType) {
    case 'earnings': return ['revenue', 'earnings', 'valuation', 'guidance', 'sentiment'];
    case 'dividend': case 'bonus': case 'split': case 'rights': case 'buyback':
      return ['corporate-actions', 'valuation', 'price'];
    case 'merger': case 'demerger': return ['structure', 'valuation', 'sector', 'price'];
    case 'promoter-action': case 'pledging': return ['ownership', 'governance', 'sentiment'];
    case 'management-change': return ['management', 'governance', 'sentiment'];
    case 'regulatory': return ['regulatory', 'valuation', 'sentiment'];
    case 'macro': return ['macro', 'regime', 'valuation'];
    default: return ['general'];
  }
}

let eventSeq = 0;

export function corpActionToEvent(action: CorporateActionRecord, receivedAt: number): MarketEvent {
  const typeMap: Record<CorporateActionRecord['action'], MarketEventType> = {
    split: 'split', dividend: 'dividend', bonus: 'bonus', rights: 'rights', buyback: 'buyback', other: 'custom'
  };
  if (!Number.isFinite(action.ex_date) || action.ex_date <= 0) {
    throw new Error('EVENT_INVALID_DATE: corporate action needs a valid ex_date');
  }
  return {
    event_id: `mev-${(eventSeq += 1)}-${action.action}`,
    event_type: typeMap[action.action],
    entity_refs: action.instrument_ids.map((id) => `instrument:${id}`),
    instrument_ids: [...action.instrument_ids],
    occurred_at: action.ex_date,
    received_at: receivedAt,
    source: action.source,
    payload: { ...action.payload }
  };
}

export function earningsEvent(instrumentIds: string[], occurredAt: number, receivedAt: number, source: string, payload: Record<string, unknown> = {}): MarketEvent {
  return {
    event_id: `mev-${(eventSeq += 1)}-earnings`,
    event_type: 'earnings',
    entity_refs: instrumentIds.map((id) => `instrument:${id}`),
    instrument_ids: [...instrumentIds],
    occurred_at: occurredAt,
    received_at: receivedAt,
    source,
    payload: { ...payload }
  };
}

/** Deterministic fixture provider for tests/demo (never production ingestion). */
export class StubProvider implements QuoteProvider, BarProvider, CorporateActionProvider, InstrumentProvider {
  readonly name: string;
  constructor(
    name: string,
    private bars: CanonicalBar[] = [],
    private quotes: CanonicalQuote[] = [],
    private actions: CorporateActionRecord[] = [],
    private instruments: InstrumentRef[] = []
  ) {
    this.name = name;
  }
  getQuote(instrumentId: string): CanonicalQuote | undefined {
    return this.quotes.filter((q) => q.instrument_id === instrumentId).sort((a, b) => b.ts - a.ts)[0];
  }
  getBars(instrumentId: string, timeframe: string): CanonicalBar[] {
    return this.bars.filter((b) => b.instrument_id === instrumentId && b.timeframe === timeframe).sort((a, b) => a.ts - b.ts);
  }
  getActions(instrumentId: string): CorporateActionRecord[] {
    return this.actions.filter((a) => a.instrument_ids.includes(instrumentId));
  }
  getInstrument(instrumentId: string): InstrumentRef | undefined {
    return this.instruments.find((i) => i.instrument_id === instrumentId);
  }
}
