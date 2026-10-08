// Canonical vendor-neutral market-data types. No exchange branches: NSE/BSE/MCX
// appear only as data values. Timestamps are explicit (epoch ms + IANA tz).

export interface InstrumentRef {
  instrument_id: string;
  exchange: string;
  market: string;
  segment: string;
  symbol: string;
  contract?: { kind: 'FUT' | 'CALL' | 'PUT' | 'SPOT'; expiry?: string; strike?: number };
}

export interface DataProvenance {
  provider: string;
  source: string;
  retrieved_at: number;
  observed_at: number;
  data_version?: string;
}

export interface CanonicalBar extends InstrumentRef, DataProvenance {
  kind: 'bar';
  timeframe: string;
  ts: number;
  tz: string;
  ts_original: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CanonicalQuote extends InstrumentRef, DataProvenance {
  kind: 'quote';
  ts: number;
  tz: string;
  ts_original: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  bid_qty: number | null;
  ask_qty: number | null;
}

export type MarketRecord = CanonicalBar | CanonicalQuote;

export type QualityVerdict = 'VALID' | 'SUSPECT' | 'QUARANTINED';

export interface QualityReport {
  verdict: QualityVerdict;
  reasons: string[];
  checked_at: number;
}

export interface QualityContext {
  now: number;
  lastTs?: number;
  seenIds?: Set<string>;
  refPrice?: number;
  jumpPct?: number;
  peerPrices?: number[];
  peerDisagreeBps?: number;
  maxAgeMs?: number;
  futureSkewMs?: number;
}

export type DataDomain = 'tick' | 'intraday' | 'daily' | 'fundamental' | 'static' | 'default';

export interface MarketDataProvider {
  readonly name: string;
}
export interface QuoteProvider extends MarketDataProvider {
  getQuote(instrumentId: string): CanonicalQuote | undefined;
}
export interface BarProvider extends MarketDataProvider {
  getBars(instrumentId: string, timeframe: string): CanonicalBar[];
}
export interface CorporateActionProvider extends MarketDataProvider {
  getActions(instrumentId: string): CorporateActionRecord[];
}
export interface InstrumentProvider extends MarketDataProvider {
  getInstrument(instrumentId: string): InstrumentRef | undefined;
}

export interface CorporateActionRecord {
  action: 'split' | 'dividend' | 'bonus' | 'rights' | 'buyback' | 'other';
  instrument_ids: string[];
  ex_date: number;
  payload: Record<string, unknown>;
  source: string;
}

export type MarketEventType =
  | 'earnings' | 'dividend' | 'split' | 'bonus' | 'rights' | 'buyback'
  | 'merger' | 'demerger' | 'promoter-action' | 'pledging' | 'management-change'
  | 'regulatory' | 'macro' | 'custom';

export interface MarketEvent {
  event_id: string;
  event_type: MarketEventType;
  entity_refs: string[];
  instrument_ids: string[];
  occurred_at: number;
  received_at: number;
  source: string;
  payload: Record<string, unknown>;
}
