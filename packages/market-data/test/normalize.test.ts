import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { normalizeBar, normalizeQuote } from '../src/index.js';

const REF = {
  instrument_id: 'X', exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: 'X',
  ts: 1_700_000_000_000, tz: 'Asia/Kolkata', open: 100, high: 105, low: 99, close: 103, volume: 1000
};

describe('normalization', () => {
  it('normalizes a bar with explicit timezone', () => {
    const bar = normalizeBar({ ...REF }, 'stub');
    expect(bar.tz).toBe('Asia/Kolkata');
    expect(bar.provider).toBe('stub');
    expect(bar.observed_at).toBeLessThanOrEqual(Date.now());
  });

  it('rejects ambiguous timestamps (no tz)', () => {
    const { tz, ...rest } = REF;
    void tz;
    expect(() => normalizeBar({ ...rest }, 'stub')).toThrow(/AMBIGUOUS_TIMEZONE/);
  });

  it('rejects missing fields', () => {
    expect(() => normalizeBar({ ...REF, close: undefined }, 'stub')).toThrow(/NORMALIZE_MISSING_FIELD/);
  });

  it('parses ISO datetimes with required tz', () => {
    const { ts, ...rest } = REF;
    void ts;
    const bar = normalizeBar({ ...rest, datetime: '2024-01-01T09:15:00+05:30' }, 'stub');
    expect(bar.ts).toBe(Date.parse('2024-01-01T09:15:00+05:30'));
  });

  it('normalizes quotes with nullable sides', () => {
    const q = normalizeQuote({ ...REF, price: 103, bid: 102.9, ask: 103.1 }, 'stub');
    expect(q.bid).toBeCloseTo(102.9);
    expect(q.ask).toBeCloseTo(103.1);
  });

  it('core stays vendor-neutral (no exchange branches)', () => {
    for (const f of readdirSync('packages/market-data/src')) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(`packages/market-data/src/${f}`, 'utf8');
      expect(src).not.toMatch(/'NSE'|"NSE"|case 'NSE'|NSE_EQ/);
    }
    // Same code path handles any venue as data.
    const bse = normalizeBar({ ...REF, exchange: 'BSE', instrument_id: 'Y' }, 'stub');
    expect(bse.exchange).toBe('BSE');
  });
});
