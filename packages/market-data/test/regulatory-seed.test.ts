import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEligibility, seedEligibility } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const seed = JSON.parse(readFileSync(join(root, 'config', 'regulatory-seed.v1.json'), 'utf8'));

describe('regulatory seed file (U1)', () => {
  it('carries version, as_of, refresh cadence and honest coverage', () => {
    expect(seed.version).toBe('regulatory-seed-v1');
    expect(seed.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(seed.refresh_cadence).toMatch(/per-release/);
    expect(Array.isArray(seed.rules)).toBe(true);
    expect(seed.coverage).toMatch(/UNKNOWN/);
  });

  it('every seeded rule (if any) carries source + as_of and validates', () => {
    const rows = seedEligibility(seed.rules.map((r: Record<string, unknown>) => {
      expect(typeof r.source).toBe('string');
      expect((r.source as string).length).toBeGreaterThan(0);
      expect(r.as_of).toBeDefined();
      return r;
    }) as never[]);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('empty seed resolves UNKNOWN (fail-closed, never an approval)', () => {
    const rows = seedEligibility([]);
    const r = resolveEligibility(rows, 'NSE_EQ_RELIANCE', Date.now(), 7 * 86_400_000);
    expect(r.state).toBe('UNKNOWN');
  });
});
