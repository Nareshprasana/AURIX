// Versioned datasets with point-in-time discipline. Bars, fundamentals, actions
// and events expose only what was knowable at time t. Adjustment methodology is
// recorded; double-adjustment is guarded by applied-action ids.
import { cyrb53hex, stableStringify } from '@aurix/knowledge-service';

export interface DatasetBar {
  instrument_id: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread_bps: number | null;
  adv_value: number | null;
}

export interface PriceAdjustment {
  id: string;
  instrument_id: string;
  ex_ts: number;
  factor: number;
  type: 'split' | 'bonus';
  source: string;
  version: string;
}

export interface DividendAction {
  id: string;
  instrument_id: string;
  ex_ts: number;
  amount_per_share: number;
  source: string;
}

export interface DatasetFundamental {
  instrument_id: string;
  metric: string;
  value: number;
  period: string;
  published_at: number;
  source: string;
}

export interface DatasetEvent {
  event_id: string;
  event_type: string;
  entity_refs: string[];
  instrument_ids: string[];
  occurred_at: number;
}

export interface UniverseEntry {
  instrument_id: string;
  listing_ts: number;
}

export interface BacktestDataset {
  id: string;
  version: string;
  timeframe: string;
  bars: DatasetBar[];
  adjustments: PriceAdjustment[];
  dividends: DividendAction[];
  fundamentals: DatasetFundamental[];
  events: DatasetEvent[];
  universe: UniverseEntry[];
  calendar_version: string;
  source: string;
  bars_hash: string;
  range: { from_ts: number; to_ts: number };
  limitations: string[];
}

export function hashBars(bars: DatasetBar[]): string {
  return cyrb53hex(stableStringify(bars.map((b) => [b.instrument_id, b.ts, b.open, b.high, b.low, b.close, b.volume])));
}

export function buildDataset(input: {
  id: string;
  timeframe: string;
  bars: DatasetBar[];
  adjustments?: PriceAdjustment[];
  dividends?: DividendAction[];
  fundamentals?: DatasetFundamental[];
  events?: DatasetEvent[];
  universe?: UniverseEntry[];
  calendar_version?: string;
  source?: string;
}): BacktestDataset {
  const limitations: string[] = [];
  const instruments = [...new Set(input.bars.map((b) => b.instrument_id))];
  if (input.bars.some((b) => b.adv_value === null || b.adv_value === undefined)) {
    limitations.push('adv unknown for some bars: liquidity-aware terms degrade to assumptions');
  }
  if (input.bars.some((b) => b.spread_bps === null || b.spread_bps === undefined)) {
    limitations.push('spread unknown for some bars: spread recorded as assumption');
  }
  if ((input.fundamentals ?? []).length === 0) limitations.push('no fundamentals: fundamental families NOT_APPLICABLE');
  const ts = input.bars.map((b) => b.ts);
  return {
    id: input.id,
    version: `ds-${hashBars(input.bars).slice(0, 12)}`,
    timeframe: input.timeframe,
    bars: [...input.bars].sort((a, b) => a.ts - b.ts || (a.instrument_id < b.instrument_id ? -1 : 1)),
    adjustments: input.adjustments ?? [],
    dividends: input.dividends ?? [],
    fundamentals: input.fundamentals ?? [],
    events: input.events ?? [],
    universe: input.universe ?? instruments.map((instrument_id) => ({ instrument_id, listing_ts: 0 })),
    calendar_version: input.calendar_version ?? 'cal-weekday-v1',
    source: input.source ?? 'fixture',
    bars_hash: hashBars(input.bars),
    range: { from_ts: Math.min(...ts), to_ts: Math.max(...ts) },
    limitations
  };
}

export interface AdjustedSeries {
  instrument_id: string;
  bars: DatasetBar[];
  applied: { action_id: string; method: string; version: string }[];
}

/** Ratio-adjust pre-ex bars (divide O/H/L/C by factor). Each action applied once. */
export function adjustSeries(dataset: BacktestDataset): AdjustedSeries[] {
  const byInstrument = new Map<string, DatasetBar[]>();
  for (const b of dataset.bars) {
    const list = byInstrument.get(b.instrument_id) ?? [];
    list.push({ ...b });
    byInstrument.set(b.instrument_id, list);
  }
  const out: AdjustedSeries[] = [];
  for (const [instrument_id, bars] of byInstrument) {
    const applied: { action_id: string; method: string; version: string }[] = [];
    const seen = new Set<string>();
    const actions = dataset.adjustments
      .filter((a) => a.instrument_id === instrument_id)
      .sort((a, b) => a.ex_ts - b.ex_ts);
    for (const a of actions) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      for (const bar of bars) {
        if (bar.ts < a.ex_ts) {
          bar.open /= a.factor;
          bar.high /= a.factor;
          bar.low /= a.factor;
          bar.close /= a.factor;
        }
      }
      applied.push({ action_id: a.id, method: 'pre-ex-divide', version: 'adj-v1' });
    }
    bars.sort((a, b) => a.ts - b.ts);
    out.push({ instrument_id, bars, applied });
  }
  return out;
}

// -- point-in-time views (strictly <= t; never the future) -----------------------

export function barsAsOf(series: AdjustedSeries, t: number): DatasetBar[] {
  return series.bars.filter((b) => b.ts <= t);
}

export function universeAsOf(dataset: BacktestDataset, t: number): string[] {
  return dataset.universe.filter((u) => u.listing_ts <= t).map((u) => u.instrument_id);
}

export function fundamentalsAsOf(dataset: BacktestDataset, t: number): DatasetFundamental[] {
  return dataset.fundamentals.filter((f) => f.published_at <= t);
}

export function eventsAsOf(dataset: BacktestDataset, t: number): DatasetEvent[] {
  return dataset.events.filter((e) => e.occurred_at <= t);
}
