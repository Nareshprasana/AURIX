import { describe, expect, it, beforeEach } from 'vitest';
import { ValuationAgent } from '../src/index.js';
import type { AgentContext } from '../src/index.js';
import { NOW, resetResearch, valuationInput } from './helpers.js';

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

describe('valuation agent', () => {
  beforeEach(resetResearch);

  it('computes ratios with assumptions and uncertainty', async () => {
    const agent = new ValuationAgent();
    const r = await agent.run(ctxFor({ evidence: [valuationInput('price', 4000, 'p'), valuationInput('eps', 200, 'e'), valuationInput('book_value', 1000, 'b')] }));
    expect(r.status).toBe('COMPLETED');
    const pe = r.observations.find((o) => o.metric === 'P/E');
    expect(pe?.value).toBeCloseTo(20);
    expect(pe?.statement).toMatch(/uncertainty band/);
    expect(r.assumptions.length).toBeGreaterThan(0);
  });

  it('validates inputs and lists gaps when missing', async () => {
    const agent = new ValuationAgent();
    const r = await agent.run(ctxFor({ evidence: [valuationInput('price', 4000, 'p')] }));
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.missing.join(' ')).toMatch(/missing input: eps/);
  });

  it('marks partial coverage explicitly', async () => {
    const agent = new ValuationAgent();
    const r = await agent.run(ctxFor({ evidence: [valuationInput('price', 4000, 'p'), valuationInput('eps', 200, 'e')] }));
    expect(r.status).toBe('PARTIAL');
    expect(r.observations).toHaveLength(1);
  });

  it('stamps the calculation version', async () => {
    const agent = new ValuationAgent();
    expect(ValuationAgent.CALC_VERSION).toBe('valuation-v1');
    const r = await agent.run(ctxFor({ evidence: [valuationInput('price', 10, 'p'), valuationInput('eps', 2, 'e')] }));
    expect(r.methodology).toMatch(/valuation-v1/);
  });
});
