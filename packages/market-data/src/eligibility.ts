// Instrument eligibility registry helpers (P1-6): stale-aware resolution over
// seeded eligibility rows. Deterministic; no network; no venue branches.
//
// Approved scope (architecture 5.3: schema + seed + fail-closed checks; the
// full regulatory-intel worker is Phase 3+ and is NOT invented here):
//   - record source/timestamp/version/provenance per row (matches the
//     eligibility DDL: instrument_id, state, reason, source, as_of)
//   - resolve the effective state for an instrument at time T
//   - force UNKNOWN when the record is missing, malformed, or stale
// Missing evidence is never converted into a legal approval: anything but a
// fresh, well-formed LEGAL row resolves to a blocking state.
import type { EligibilityState } from '@aurix/contracts';

export interface EligibilityRecord {
  instrument_id: string;
  state: EligibilityState;
  reason: string;
  source: string;
  as_of: number;
  version: string;
}

export interface EligibilityResolution {
  instrument_id: string;
  state: EligibilityState;
  reason: string;
  source: string | null;
  as_of: number | null;
  stale: boolean;
}

const KNOWN_STATES: readonly string[] = ['LEGAL', 'RESTRICTED', 'UNAVAILABLE', 'UNKNOWN'];

export function seedEligibility(rows: Omit<EligibilityRecord, 'version'>[], version = 'eligibility-seed-v1'): EligibilityRecord[] {
  return rows.map((r) => {
    if (typeof r.instrument_id !== 'string' || r.instrument_id.length === 0) {
      throw new Error('ELIGIBILITY_MISSING_FIELD: instrument_id');
    }
    if (!KNOWN_STATES.includes(r.state)) {
      throw new Error(`ELIGIBILITY_UNKNOWN_STATE: ${String(r.state)}`);
    }
    if (typeof r.as_of !== 'number' || !Number.isFinite(r.as_of)) {
      throw new Error('ELIGIBILITY_MISSING_FIELD: as_of');
    }
    if (typeof r.source !== 'string' || r.source.length === 0) {
      throw new Error('ELIGIBILITY_MISSING_FIELD: source');
    }
    return { ...r, version };
  });
}

/** Resolve effective eligibility. Stale or absent rows fail closed to UNKNOWN. */
export function resolveEligibility(
  records: EligibilityRecord[],
  instrumentId: string,
  nowMs: number,
  staleAfterMs: number
): EligibilityResolution {
  const matches = records.filter((r) => r.instrument_id === instrumentId);
  if (matches.length === 0) {
    return { instrument_id: instrumentId, state: 'UNKNOWN', reason: 'no eligibility record', source: null, as_of: null, stale: true };
  }
  const latest = matches.reduce((a, b) => (b.as_of > a.as_of ? b : a));
  if (!KNOWN_STATES.includes(latest.state)) {
    return { instrument_id: instrumentId, state: 'UNKNOWN', reason: `malformed state ${String(latest.state)}`, source: latest.source ?? null, as_of: latest.as_of, stale: true };
  }
  if (nowMs - latest.as_of > staleAfterMs) {
    return { instrument_id: instrumentId, state: 'UNKNOWN', reason: `stale record (${nowMs - latest.as_of}ms old)`, source: latest.source, as_of: latest.as_of, stale: true };
  }
  return { instrument_id: instrumentId, state: latest.state, reason: latest.reason, source: latest.source, as_of: latest.as_of, stale: false };
}

/** Tradability predicate mirroring the order boundary (LEGAL only). */
export function isTradable(resolution: EligibilityResolution): boolean {
  return resolution.state === 'LEGAL' && !resolution.stale;
}
