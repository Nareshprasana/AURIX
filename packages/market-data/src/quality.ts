// Normalization (structural) + quality assessment (semantic) + quarantine +
// per-domain freshness. Deterministic; no network; no venue branches.
import type {
  CanonicalBar,
  CanonicalQuote,
  CorporateActionProvider,
  DataDomain,
  InstrumentRef,
  MarketRecord,
  QualityContext,
  QualityReport,
  QualityVerdict
} from './types.js';

export function recordId(r: MarketRecord): string {
  return `${r.instrument_id}|${r.ts}|${r.provider}`;
}

// -- normalization ------------------------------------------------------------

function baseRef(raw: Record<string, unknown>, provider: string): InstrumentRef & { provider: string; retrieved_at: number; observed_at: number; source: string; data_version?: string } {
  for (const f of ['instrument_id', 'exchange', 'market', 'segment', 'symbol']) {
    if (typeof raw[f] !== 'string' || (raw[f] as string).length === 0) {
      throw new Error(`NORMALIZE_MISSING_FIELD: ${f}`);
    }
  }
  return {
    instrument_id: raw['instrument_id'] as string,
    exchange: raw['exchange'] as string,
    market: raw['market'] as string,
    segment: raw['segment'] as string,
    symbol: raw['symbol'] as string,
    ...(raw['contract'] !== undefined ? { contract: raw['contract'] as InstrumentRef['contract'] } : {}),
    provider,
    source: typeof raw['source'] === 'string' ? (raw['source'] as string) : provider,
    retrieved_at: typeof raw['retrieved_at'] === 'number' ? (raw['retrieved_at'] as number) : Date.now(),
    observed_at: typeof raw['observed_at'] === 'number' ? (raw['observed_at'] as number) : Date.now(),
    ...(typeof raw['data_version'] === 'string' ? { data_version: raw['data_version'] as string } : {})
  };
}

function resolveTs(raw: Record<string, unknown>): { ts: number; ts_original: string } {
  const tz = raw['tz'];
  if (typeof tz !== 'string' || tz.length === 0) {
    throw new Error('AMBIGUOUS_TIMEZONE: explicit tz required (never assume exchange timezone)');
  }
  let ts: number;
  let tsOriginal: string;
  if (typeof raw['ts'] === 'number') {
    ts = raw['ts'];
    tsOriginal = String(raw['ts']);
  } else if (typeof raw['datetime'] === 'string') {
    ts = Date.parse(raw['datetime']);
    tsOriginal = raw['datetime'];
  } else {
    throw new Error('NORMALIZE_MISSING_FIELD: ts|datetime');
  }
  return { ts, ts_original: tsOriginal };
}

export function normalizeBar(raw: Record<string, unknown>, provider: string): CanonicalBar {
  const ref = baseRef(raw, provider);
  const { ts, ts_original } = resolveTs(raw);
  for (const f of ['open', 'high', 'low', 'close', 'volume'] as const) {
    if (typeof raw[f] !== 'number') throw new Error(`NORMALIZE_MISSING_FIELD: ${f}`);
  }
  return {
    ...ref,
    kind: 'bar',
    timeframe: typeof raw['timeframe'] === 'string' ? raw['timeframe'] : '1D',
    ts,
    tz: raw['tz'] as string,
    ts_original,
    open: raw['open'] as number,
    high: raw['high'] as number,
    low: raw['low'] as number,
    close: raw['close'] as number,
    volume: raw['volume'] as number
  };
}

export function normalizeQuote(raw: Record<string, unknown>, provider: string): CanonicalQuote {
  const ref = baseRef(raw, provider);
  const { ts, ts_original } = resolveTs(raw);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    ...ref,
    kind: 'quote',
    ts,
    tz: raw['tz'] as string,
    ts_original,
    price: num(raw['price']),
    bid: num(raw['bid']),
    ask: num(raw['ask']),
    bid_qty: num(raw['bid_qty']),
    ask_qty: num(raw['ask_qty'])
  };
}

// -- quality --------------------------------------------------------------------

const EPS = 1e-9;

function push(reasons: string[], level: 'Q' | 'S', msg: string, quarantine: string[], suspect: string[]): void {
  reasons.push(msg);
  if (level === 'Q') quarantine.push(msg);
  else suspect.push(msg);
}

export function assessBar(bar: CanonicalBar, ctx: QualityContext): QualityReport {
  const reasons: string[] = [];
  const q: string[] = [];
  const s: string[] = [];
  const skew = ctx.futureSkewMs ?? 60_000;
  if (!Number.isFinite(bar.ts) || bar.ts <= 0) push(reasons, 'Q', 'invalid timestamp', q, s);
  if (bar.ts > ctx.now + skew) push(reasons, 'Q', 'future timestamp', q, s);
  if (ctx.seenIds && ctx.seenIds.has(recordId(bar))) push(reasons, 'Q', 'duplicate record', q, s);
  if (ctx.lastTs !== undefined && bar.ts <= ctx.lastTs) push(reasons, 'Q', 'out-of-order record', q, s);
  for (const [f, v] of [['open', bar.open], ['high', bar.high], ['low', bar.low], ['close', bar.close]] as const) {
    if (!Number.isFinite(v)) push(reasons, 'Q', `invalid ${f}`, q, s);
    else if (v < 0) push(reasons, 'Q', `negative price ${f}`, q, s);
  }
  if (!Number.isFinite(bar.volume)) push(reasons, 'Q', 'invalid volume', q, s);
  else if (bar.volume < 0) push(reasons, 'Q', 'negative volume', q, s);
  else if (bar.volume === 0) push(reasons, 'S', 'zero volume', q, s);
  if (bar.high + EPS < bar.low) push(reasons, 'Q', 'impossible OHLC: high<low', q, s);
  if (bar.open < bar.low - EPS || bar.open > bar.high + EPS) push(reasons, 'Q', 'open outside [low,high]', q, s);
  if (bar.close < bar.low - EPS || bar.close > bar.high + EPS) push(reasons, 'Q', 'close outside [low,high]', q, s);
  if (ctx.maxAgeMs !== undefined && ctx.now - bar.ts > ctx.maxAgeMs) push(reasons, 'S', 'stale observation', q, s);
  if (ctx.refPrice !== undefined && ctx.refPrice > 0) {
    const jump = Math.abs(bar.close - ctx.refPrice) / ctx.refPrice;
    if (jump > (ctx.jumpPct ?? 0.1)) push(reasons, 'S', `unexpected price jump ${(jump * 100).toFixed(1)}%`, q, s);
  }
  if (ctx.peerPrices && ctx.peerPrices.length > 0) {
    const sorted = [...ctx.peerPrices].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median > 0 && (Math.abs(bar.close - median) / median) * 10_000 > (ctx.peerDisagreeBps ?? 50)) {
      push(reasons, 'S', 'provider disagreement', q, s);
    }
  }
  const verdict: QualityVerdict = q.length > 0 ? 'QUARANTINED' : s.length > 0 ? 'SUSPECT' : 'VALID';
  return { verdict, reasons, checked_at: ctx.now };
}

export function assessQuote(quote: CanonicalQuote, ctx: QualityContext): QualityReport {
  const reasons: string[] = [];
  const q: string[] = [];
  const s: string[] = [];
  const skew = ctx.futureSkewMs ?? 60_000;
  if (!Number.isFinite(quote.ts) || quote.ts <= 0) push(reasons, 'Q', 'invalid timestamp', q, s);
  if (quote.ts > ctx.now + skew) push(reasons, 'Q', 'future timestamp', q, s);
  if (ctx.seenIds && ctx.seenIds.has(recordId(quote))) push(reasons, 'Q', 'duplicate record', q, s);
  if (ctx.lastTs !== undefined && quote.ts <= ctx.lastTs) push(reasons, 'Q', 'out-of-order record', q, s);
  for (const [f, v] of [['price', quote.price], ['bid', quote.bid], ['ask', quote.ask], ['bid_qty', quote.bid_qty], ['ask_qty', quote.ask_qty]] as const) {
    if (v === null) continue;
    if (!Number.isFinite(v)) push(reasons, 'Q', `invalid ${f}`, q, s);
    else if (v < 0) push(reasons, 'Q', `negative ${f}`, q, s);
    else if (v === 0 && (f === 'price' || f === 'bid' || f === 'ask')) push(reasons, 'S', `zero ${f}`, q, s);
  }
  if (quote.bid !== null && quote.ask !== null && quote.bid > quote.ask + EPS) {
    push(reasons, 'Q', 'impossible quote: bid>ask', q, s);
  }
  if (ctx.maxAgeMs !== undefined && ctx.now - quote.ts > ctx.maxAgeMs) push(reasons, 'S', 'stale observation', q, s);
  const ref = quote.price ?? (quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : null);
  if (ref !== null && ctx.refPrice !== undefined && ctx.refPrice > 0) {
    const jump = Math.abs(ref - ctx.refPrice) / ctx.refPrice;
    if (jump > (ctx.jumpPct ?? 0.1)) push(reasons, 'S', `unexpected price jump ${(jump * 100).toFixed(1)}%`, q, s);
  }
  if (ctx.peerPrices && ctx.peerPrices.length > 0 && ref !== null) {
    const sorted = [...ctx.peerPrices].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median > 0 && (Math.abs(ref - median) / median) * 10_000 > (ctx.peerDisagreeBps ?? 50)) {
      push(reasons, 'S', 'provider disagreement', q, s);
    }
  }
  const verdict: QualityVerdict = q.length > 0 ? 'QUARANTINED' : s.length > 0 ? 'SUSPECT' : 'VALID';
  return { verdict, reasons, checked_at: ctx.now };
}

// -- quarantine (retains provenance + reasons; explicit release only) ----------

export interface QuarantineReceipt {
  id: string;
  record: MarketRecord;
  report: QualityReport;
  quarantined_at: number;
  released: { at: number; reason: string; actor: string } | null;
}

export class Quarantine {
  private held = new Map<string, QuarantineReceipt>();
  private seq = 0;
  hold(record: MarketRecord, report: QualityReport, at: number): QuarantineReceipt {
    if (report.verdict !== 'QUARANTINED') throw new Error('QUARANTINE_REJECTS_CLEAN: only QUARANTINED verdicts may be held');
    const id = `q-${(this.seq += 1)}-${recordId(record).replace(/[^A-Za-z0-9]/g, '_')}`;
    const receipt: QuarantineReceipt = { id, record, report, quarantined_at: at, released: null };
    this.held.set(id, receipt);
    return receipt;
  }
  list(): QuarantineReceipt[] {
    return [...this.held.values()].filter((r) => r.released === null);
  }
  /** Explicit re-assessment required: only a fresh VALID report releases. */
  release(id: string, report: QualityReport, reason: string, actor: string, at: number): MarketRecord {
    const r = this.held.get(id);
    if (!r) throw new Error(`QUARANTINE_UNKNOWN: ${id}`);
    if (report.verdict !== 'VALID') throw new Error('QUARANTINE_STAYS: release requires a fresh VALID report');
    r.released = { at, reason, actor };
    this.held.delete(id);
    return r.record;
  }
  size(): number {
    return this.list().length;
  }
}

// -- data freshness (per-domain, configurable) ----------------------------------

export const DATA_FRESHNESS: Record<DataDomain, { freshMs: number; agingMs: number }> = {
  tick: { freshMs: 5_000, agingMs: 30_000 },
  intraday: { freshMs: 15 * 60_000, agingMs: 60 * 60_000 },
  daily: { freshMs: 48 * 3600_000, agingMs: 7 * 24 * 3600_000 },
  fundamental: { freshMs: 90 * 24 * 3600_000, agingMs: 180 * 24 * 3600_000 },
  static: { freshMs: 365 * 24 * 3600_000, agingMs: 730 * 24 * 3600_000 },
  default: { freshMs: 24 * 3600_000, agingMs: 7 * 24 * 3600_000 }
};

export type Freshness = 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';

export function classifyDataAge(domain: DataDomain, ageMs: number | null, policy: Record<DataDomain, { freshMs: number; agingMs: number }> = DATA_FRESHNESS): Freshness {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return 'UNKNOWN';
  const p = policy[domain] ?? policy['default']!;
  if (ageMs <= p.freshMs) return 'FRESH';
  if (ageMs <= p.agingMs) return 'AGING';
  return 'STALE';
}

export function dataFreshness(record: MarketRecord, domain: DataDomain, now: number): Freshness {
  if (!Number.isFinite(record.ts) || record.ts <= 0) return 'UNKNOWN';
  return classifyDataAge(domain, now - record.ts);
}

export type { CorporateActionProvider };
