import { describe, expect, it, beforeEach } from 'vitest';
import { earningsEvent } from '@aurix/market-data';
import { bars, makeResearch, metricEv, NOW, resetResearch } from './helpers.js';

describe('scoped invalidation (event → affected research only)', () => {
  beforeEach(resetResearch);

  function seed() {
    const { orch } = makeResearch();
    const fund = [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')];
    return orch.investigate({ subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 't', actor: 't', evidence: fund, now: NOW })
      .then(() => orch.investigate({ subject: 'company:INFY', objective: 'price trend analysis', agent: 't', actor: 't', bars: bars(25), now: NOW }))
      .then(() => orch);
  }

  it('new event invalidates relevant research', async () => {
    const orch = await seed();
    const ev = earningsEvent(['TCS'], NOW + 1, NOW + 1, 'exchange');
    ev.entity_refs = ['company:TCS'];
    const affected = orch.affectedTasks(ev);
    expect(affected).toHaveLength(1);
  });

  it('unrelated event leaves unrelated research reusable', async () => {
    const orch = await seed();
    const ev = earningsEvent(['WIPRO'], NOW + 1, NOW + 1, 'exchange');
    ev.entity_refs = ['company:WIPRO'];
    expect(orch.affectedTasks(ev)).toHaveLength(0);
    const r = await orch.investigate({ subject: 'company:INFY', objective: 'price trend analysis', agent: 't', actor: 't', bars: bars(25), now: NOW + 2 });
    expect(r.path).toBe('REUSE');
  });

  it('fresh result is reused until the dependency changes', async () => {
    const orch = await seed();
    const r = await orch.investigate({ subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 't', actor: 't', evidence: [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')], now: NOW + 5 });
    expect(r.path).toBe('REUSE');
  });

  it('stale result refreshes only after its own dependencies move', async () => {
    const orch = await seed();
    const ev = earningsEvent(['TCS'], NOW + 10, NOW + 10, 'exchange');
    ev.entity_refs = ['company:TCS'];
    const res = await orch.refreshForEvent(ev, 't', NOW + 10);
    expect(res.markers.length).toBeGreaterThan(0);
    expect(res.refreshed).toHaveLength(1);
    expect(res.refreshed[0]?.outcome.path).toBe('REFRESH');
  });
});
