import { describe, expect, it } from 'vitest';
import { assessBar, assessQuote, normalizeBar, normalizeQuote, Quarantine, classifyDataAge, dataFreshness } from '../src/index.js';

const NOW = 1_800_000_000_000;
const REF = {
  instrument_id: 'X', exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: 'X',
  ts: NOW - 1000, tz: 'Asia/Kolkata', open: 100, high: 105, low: 99, close: 103, volume: 1000
};
const CTX = { now: NOW };

describe('data quality', () => {
  it('accepts a valid bar', () => {
    const r = assessBar(normalizeBar({ ...REF }, 'stub'), CTX);
    expect(r.verdict).toBe('VALID');
    expect(r.reasons).toHaveLength(0);
  });

  it('quarantines invalid data (negative price, high<low, future ts)', () => {
    expect(assessBar(normalizeBar({ ...REF, close: -5 }, 'stub'), CTX).verdict).toBe('QUARANTINED');
    expect(assessBar(normalizeBar({ ...REF, high: 90, low: 99 }, 'stub'), CTX).verdict).toBe('QUARANTINED');
    expect(assessBar(normalizeBar({ ...REF, ts: NOW + 3600_000 }, 'stub'), CTX).verdict).toBe('QUARANTINED');
    expect(assessBar(normalizeBar({ ...REF, volume: -3 }, 'stub'), CTX).verdict).toBe('QUARANTINED');
  });

  it('quarantines duplicates and out-of-order records', () => {
    const bar = normalizeBar({ ...REF }, 'stub');
    const seen = new Set<string>([`${bar.instrument_id}|${bar.ts}|${bar.provider}`]);
    expect(assessBar(bar, { ...CTX, seenIds: seen }).verdict).toBe('QUARANTINED');
    expect(assessBar(bar, { ...CTX, lastTs: bar.ts }).verdict).toBe('QUARANTINED');
  });

  it('flags suspect data (stale, jump, disagreement, zero volume)', () => {
    expect(assessBar(normalizeBar({ ...REF }, 'stub'), { ...CTX, maxAgeMs: 100 }).verdict).toBe('SUSPECT');
    expect(assessBar(normalizeBar({ ...REF }, 'stub'), { ...CTX, refPrice: 50 }).verdict).toBe('SUSPECT');
    expect(assessBar(normalizeBar({ ...REF }, 'stub'), { ...CTX, peerPrices: [200, 201] }).verdict).toBe('SUSPECT');
    expect(assessBar(normalizeBar({ ...REF, volume: 0 }, 'stub'), CTX).verdict).toBe('SUSPECT');
  });

  it('quarantines impossible quotes (bid>ask)', () => {
    const q = normalizeQuote({ ...REF, price: 100, bid: 101, ask: 100 }, 'stub');
    expect(assessQuote(q, CTX).verdict).toBe('QUARANTINED');
  });

  it('quarantine retains provenance and needs explicit VALID release', () => {
    const q = new Quarantine();
    const bad = normalizeBar({ ...REF, close: -1 }, 'stub');
    const report = assessBar(bad, CTX);
    const receipt = q.hold(bad, report, NOW);
    expect(q.size()).toBe(1);
    expect(receipt.record.provider).toBe('stub');
    expect(() => q.hold(normalizeBar({ ...REF }, 'stub'), assessBar(normalizeBar({ ...REF }, 'stub'), CTX), NOW)).toThrow(/QUARANTINE_REJECTS_CLEAN/);
    expect(() => q.release(receipt.id, assessBar(bad, CTX), 'retry', 'op', NOW)).toThrow(/QUARANTINE_STAYS/);
    const good = normalizeBar({ ...REF }, 'stub');
    const released = q.release(receipt.id, assessBar(good, CTX), 'provider corrected feed', 'op', NOW);
    expect(released.instrument_id).toBe('X');
    expect(q.size()).toBe(0);
  });

  it('exposes per-domain freshness', () => {
    expect(classifyDataAge('tick', 1000)).toBe('FRESH');
    expect(classifyDataAge('tick', 60_000)).toBe('STALE');
    expect(classifyDataAge('daily', 60_000)).toBe('FRESH');
    expect(classifyDataAge('tick', null)).toBe('UNKNOWN');
    const bar = normalizeBar({ ...REF }, 'stub');
    expect(dataFreshness(bar, 'daily', NOW)).toBe('FRESH');
    expect(dataFreshness({ ...bar, ts: NaN }, 'daily', NOW)).toBe('UNKNOWN');
  });
});
