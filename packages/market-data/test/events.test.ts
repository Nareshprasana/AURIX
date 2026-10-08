import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, StubProvider, corpActionToEvent, earningsEvent, invalidationTopicsFor, normalizeBar } from '../src/index.js';

describe('event foundation', () => {
  it('covers the required event vocabulary', () => {
    for (const t of ['earnings', 'dividend', 'split', 'bonus', 'rights', 'buyback', 'merger', 'demerger', 'promoter-action', 'pledging', 'management-change', 'regulatory', 'macro']) {
      expect(EVENT_TYPES).toContain(t);
    }
  });

  it('maps corporate actions to deterministic events', () => {
    const ev = corpActionToEvent({ action: 'split', instrument_ids: ['X'], ex_date: 1_700_000_000_000, payload: { ratio: '1:5' }, source: 'exchange' }, 1_700_000_000_001);
    expect(ev.event_type).toBe('split');
    expect(ev.entity_refs).toEqual(['instrument:X']);
    expect(() => corpActionToEvent({ action: 'split', instrument_ids: ['X'], ex_date: NaN, payload: {}, source: 'x' }, 1)).toThrow(/EVENT_INVALID_DATE/);
  });

  it('builds earnings events and invalidation topic maps', () => {
    const ev = earningsEvent(['TCS'], 100, 101, 'exchange');
    expect(ev.event_type).toBe('earnings');
    expect(invalidationTopicsFor('earnings')).toContain('valuation');
    expect(invalidationTopicsFor('split')).toContain('price');
    expect(invalidationTopicsFor('custom')).toEqual(['general']);
  });

  it('StubProvider serves deterministic fixtures per venue without branches', () => {
    const bar = normalizeBar({
      instrument_id: 'X', exchange: 'BSE', market: 'equity', segment: 'EQ', symbol: 'X',
      ts: 1000, tz: 'Asia/Kolkata', timeframe: '1D', open: 1, high: 2, low: 1, close: 2, volume: 10
    }, 'stub');
    const stub = new StubProvider('stub', [bar]);
    expect(stub.getBars('X', '1D')).toHaveLength(1);
    expect(stub.getBars('X', '1h')).toHaveLength(0);
    expect(stub.getQuote('X')).toBeUndefined();
  });
});
