import { describe, expect, it, beforeEach } from 'vitest';
import { earningsEvent } from '@aurix/market-data';
import { EventIntelligenceAgent } from '../src/index.js';
import type { AgentContext } from '../src/index.js';
import { NOW, resetResearch } from './helpers.js';

function ctxFor(over: Partial<AgentContext> = {}): AgentContext {
  return {
    task: { task_id: 'task-t', subject: 'company:TCS', objective: 'test', scope: 'test', agent: 'tester' },
    memories: [],
    evidence: [],
    events: [],
    bars: [],
    quotes: [],
    gaps: [],
    qualityNotes: [],
    now: NOW,
    ...over
  };
}

const EV1 = { ...earningsEvent(['TCS'], NOW - 1000, NOW - 500, 'exchange'), entity_refs: ['company:TCS'] };

describe('event intelligence', () => {
  beforeEach(resetResearch);

  it('structures events with provenance', async () => {
    const agent = new EventIntelligenceAgent();
    const r = await agent.run(ctxFor({ events: [EV1] }));
    expect(r.status).toBe('COMPLETED');
    expect(r.observations[0]?.statement).toMatch(/earnings event/);
    expect(r.evidence[0]?.source).toBe('exchange');
  });

  it('records effective-date semantics', async () => {
    const agent = new EventIntelligenceAgent();
    const r = await agent.run(ctxFor({ events: [EV1] }));
    expect(r.observations[0]?.statement).toMatch(/occurred/);
  });

  it('dedupes repeat deliveries of the same event', async () => {
    const agent = new EventIntelligenceAgent();
    const r = await agent.run(ctxFor({ events: [EV1, { ...EV1 }] }));
    expect(r.observations).toHaveLength(1);
    expect(r.assumptions.join(' ')).toMatch(/duplicate delivery/);
  });

  it('preserves contradictory reports of the same event', async () => {
    const agent = new EventIntelligenceAgent();
    const alt = { ...EV1, source: 'wire', payload: { quarter: 'Q4' } };
    const r = await agent.run(ctxFor({ events: [EV1, alt] }));
    expect(r.status).toBe('CONFLICTED');
    expect(r.contradictions.length).toBeGreaterThan(0);
  });

  it('reports absent events honestly', async () => {
    const agent = new EventIntelligenceAgent();
    const r = await agent.run(ctxFor({}));
    expect(r.status).toBe('INSUFFICIENT_DATA');
  });
});
