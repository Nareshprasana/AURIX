import { describe, expect, it, beforeEach } from 'vitest';
import { MacroAgent } from '../src/index.js';
import type { AgentContext } from '../src/index.js';
import { NOW, macroEv, resetResearch } from './helpers.js';

function ctxFor(over: Partial<AgentContext> = {}): AgentContext {
  return {
    task: { task_id: 'task-t', subject: 'macro:IN', objective: 'test', scope: 'test', agent: 'tester' },
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

describe('macro agent', () => {
  beforeEach(resetResearch);

  it('records indicator value, period and publication time', async () => {
    const agent = new MacroAgent();
    const r = await agent.run(ctxFor({ evidence: [macroEv('CPI', 5.1, '2026-09', 'm1')] }));
    expect(r.status).toBe('COMPLETED');
    expect(r.observations[0]?.metric).toBe('CPI');
    expect(r.observations[0]?.period).toBe('2026-09');
  });

  it('tracks revisions without treating first values as final', async () => {
    const agent = new MacroAgent();
    const r = await agent.run(ctxFor({
      evidence: [
        macroEv('GDP', 6.5, 'Q2', 'm1'),
        macroEv('GDP', 6.7, 'Q2', 'm2', { revision_of: 'stat-m1', publication_ts: NOW + 1000 })
      ]
    }));
    expect(r.assumptions.join(' ')).toMatch(/not treated as final|revises/);
    expect(r.observations).toHaveLength(2);
  });

  it('notes missing publication metadata', async () => {
    const agent = new MacroAgent();
    const r = await agent.run(ctxFor({ evidence: [macroEv('CPI', 5.1, '2026-09', 'm1')] }));
    expect(r.status).toBe('COMPLETED');
  });

  it('reports absent indicators honestly', async () => {
    const agent = new MacroAgent();
    const r = await agent.run(ctxFor({}));
    expect(r.status).toBe('INSUFFICIENT_DATA');
    const novalue = await agent.run(ctxFor({ evidence: [macroEv('CPI', undefined as never, '2026-09', 'm9')] }));
    expect(novalue.status).toBe('INSUFFICIENT_DATA');
  });
});
