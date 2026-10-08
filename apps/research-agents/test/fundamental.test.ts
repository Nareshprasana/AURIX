import { describe, expect, it, beforeEach } from 'vitest';
import { FundamentalAgent } from '../src/index.js';
import type { AgentContext } from '../src/index.js';
import { metricEv, NOW, resetResearch } from './helpers.js';

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

describe('fundamental agent', () => {
  beforeEach(resetResearch);

  it('extracts metrics and computes growth across periods', async () => {
    const agent = new FundamentalAgent();
    const r = await agent.run(ctxFor({ evidence: [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')] }));
    expect(r.status).toBe('COMPLETED');
    expect(r.observations.some((o) => o.metric === 'revenue' && Math.abs((o.value as number) - 0.1) < 1e-9)).toBe(true);
    expect(r.conclusions.join(' ')).toMatch(/momentum/i);
  });

  it('handles periods and single-point metrics', async () => {
    const agent = new FundamentalAgent();
    const r = await agent.run(ctxFor({ evidence: [metricEv('debt', 50, 'FY24', 'd1')] }));
    expect(r.status).toBe('COMPLETED');
    expect(r.observations[0]?.period).toBe('FY24');
  });

  it('retains source provenance per observation', async () => {
    const agent = new FundamentalAgent();
    const r = await agent.run(ctxFor({ evidence: [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')] }));
    expect(r.sources).toContain('filing-fixture');
    expect(r.observations[0]?.inputs_ref.length).toBeGreaterThan(0);
  });

  it('reports missing data instead of inventing', async () => {
    const agent = new FundamentalAgent();
    const r = await agent.run(ctxFor({}));
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.observations).toHaveLength(0);
  });

  it('preserves contradictions with possible causes stated', async () => {
    const agent = new FundamentalAgent();
    const r = await agent.run(ctxFor({ evidence: [metricEv('revenue', 100, 'Q1', 'a'), metricEv('revenue', 120, 'Q1', 'b')] }));
    expect(r.contradictions.length).toBeGreaterThan(0);
    expect(r.contradictions.join(' ')).toMatch(/period|basis|revision|scope/i);
  });
});
