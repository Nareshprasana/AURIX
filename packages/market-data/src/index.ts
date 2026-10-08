// @aurix/market-data — vendor-neutral market-data foundation (Phase 4).
export type {
  InstrumentRef, DataProvenance, CanonicalBar, CanonicalQuote, MarketRecord,
  QualityVerdict, QualityReport, QualityContext, DataDomain,
  MarketDataProvider, QuoteProvider, BarProvider, CorporateActionProvider,
  InstrumentProvider, CorporateActionRecord, MarketEventType, MarketEvent
} from './types.js';
export {
  recordId, normalizeBar, normalizeQuote, assessBar, assessQuote,
  Quarantine, type QuarantineReceipt,
  DATA_FRESHNESS, classifyDataAge, dataFreshness, type Freshness
} from './quality.js';
export { EVENT_TYPES, invalidationTopicsFor, corpActionToEvent, earningsEvent, StubProvider } from './events.js';
