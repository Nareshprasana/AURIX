import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('contracts', () => {
  it('core model is vendor-agnostic (no NSE code branches)', () => {
    const src = readFileSync('packages/contracts/src/index.ts', 'utf8');
    expect(src).not.toMatch(/'NSE'|"NSE"|NSE_EQ|case 'NSE'/);
    expect(src).toMatch(/exchange/);
    expect(src).toMatch(/market/);
    expect(src).toMatch(/segment/);
  });

  it('eligibility discipline: UNKNOWN is distinct from LEGAL', () => {
    const src = readFileSync('packages/contracts/src/index.ts', 'utf8');
    expect(src).toMatch(/'LEGAL' \| 'RESTRICTED' \| 'UNAVAILABLE' \| 'UNKNOWN'/);
  });
});
