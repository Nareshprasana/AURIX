import { describe, expect, it } from 'vitest';
import { toSafeMode } from '../src/index.js';

describe('system-health', () => {
  it('healthy system is not in safe mode', () => {
    const r = toSafeMode({ modelAvailable: true, marketDataStale: false, brokerUnstable: false, riskHalted: false, stateCorrupt: false });
    expect(r.safeMode).toBe(false);
  });

  it('stale data triggers safe mode', () => {
    const r = toSafeMode({ modelAvailable: true, marketDataStale: true, brokerUnstable: false, riskHalted: false, stateCorrupt: false });
    expect(r.safeMode).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/stale/);
  });
});
