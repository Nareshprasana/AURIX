import { describe, expect, it } from 'vitest';
import { isTradable, resolveEligibility, seedEligibility } from '../src/index.js';
import type { EligibilityRecord } from '../src/index.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function seed(over: Partial<EligibilityRecord> = {}): EligibilityRecord[] {
  return seedEligibility([{
    instrument_id: 'NSE_EQ_RELIANCE', state: 'LEGAL', reason: 'seed review',
    source: 'seed-manual-v1', as_of: NOW - DAY, ...over
  }]);
}

describe('eligibility registry (P1-6)', () => {
  it('resolves fresh LEGAL rows as tradable with provenance', () => {
    const r = resolveEligibility(seed(), 'NSE_EQ_RELIANCE', NOW, 7 * DAY);
    expect(r).toMatchObject({ state: 'LEGAL', stale: false, source: 'seed-manual-v1' });
    expect(isTradable(r)).toBe(true);
  });

  it('forces UNKNOWN on stale records (never a silent approval)', () => {
    const r = resolveEligibility(seed(), 'NSE_EQ_RELIANCE', NOW + 30 * DAY, 7 * DAY);
    expect(r.state).toBe('UNKNOWN');
    expect(r.stale).toBe(true);
    expect(isTradable(r)).toBe(false);
  });

  it('forces UNKNOWN on missing instruments', () => {
    const r = resolveEligibility(seed(), 'NSE_EQ_UNKNOWN', NOW, 7 * DAY);
    expect(r).toMatchObject({ state: 'UNKNOWN', source: null, as_of: null });
    expect(isTradable(r)).toBe(false);
  });

  it('uses the latest record and rejects malformed states at seed time', () => {
    const rows = seedEligibility([
      { instrument_id: 'X', state: 'LEGAL', reason: 'old', source: 's', as_of: NOW - 2 * DAY },
      { instrument_id: 'X', state: 'RESTRICTED', reason: 'circuit', source: 's', as_of: NOW - DAY }
    ]);
    expect(resolveEligibility(rows, 'X', NOW, 7 * DAY).state).toBe('RESTRICTED');
    expect(() => seedEligibility([{ instrument_id: 'X', state: 'MAYBE' as never, reason: 'x', source: 's', as_of: NOW }])).toThrow(/ELIGIBILITY_UNKNOWN_STATE/);
    expect(() => seedEligibility([{ instrument_id: '', state: 'LEGAL', reason: 'x', source: 's', as_of: NOW }])).toThrow(/ELIGIBILITY_MISSING_FIELD/);
  });

  it('contradictory sources resolve by recency, never by optimism', () => {
    const rows = seedEligibility([
      { instrument_id: 'Y', state: 'RESTRICTED', reason: 'old', source: 'a', as_of: NOW - 2 * DAY },
      { instrument_id: 'Y', state: 'LEGAL', reason: 'new', source: 'b', as_of: NOW - DAY }
    ]);
    expect(resolveEligibility(rows, 'Y', NOW, 7 * DAY).state).toBe('LEGAL');
  });
});
