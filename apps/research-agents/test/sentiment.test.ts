import { describe, expect, it, beforeEach } from 'vitest';
import { classifySentiment, SentimentAgent } from '../src/index.js';
import type { AgentContext } from '../src/index.js';
import { NOW, resetResearch, textEv } from './helpers.js';

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

describe('sentiment agent', () => {
  beforeEach(resetResearch);

  it('classifies source sentiment with counts', () => {
    expect(classifySentiment('Record profit growth beats estimates, strong rally').label).toBe('positive');
    expect(classifySentiment('Weak miss triggers downgrade amid fraud probe concerns').label).toBe('negative');
    expect(classifySentiment('The meeting occurred on Tuesday').label).toBe('neutral');
  });

  it('produces per-source observations with evidence', async () => {
    const agent = new SentimentAgent();
    const r = await agent.run(ctxFor({ evidence: [textEv('n1', 'Record profit', 'Strong growth beats estimates'), textEv('n2', 'Weak quarter', 'Downgrade on weak miss amid concerns')] }));
    expect(r.status).toBe('COMPLETED');
    expect(r.observations).toHaveLength(2);
    expect(r.conclusions.join(' ')).toMatch(/inference from text signals, not fact/i);
    expect(r.knowledge_proposals[0]?.assertion).toBe('INFERENCE');
  });

  it('groups near-duplicate articles and counts once', async () => {
    const agent = new SentimentAgent();
    const dup = 'Record profit growth beats estimates with strong rally across sectors today';
    const r = await agent.run(ctxFor({ evidence: [textEv('a', 'H1', dup), textEv('b', 'H2', dup), textEv('c', 'Other', 'Weak miss triggers downgrade')] }));
    expect(r.observations).toHaveLength(2);
    expect(r.assumptions.join(' ')).toMatch(/near-duplicate/);
  });

  it('reports missing text evidence honestly', async () => {
    const agent = new SentimentAgent();
    const r = await agent.run(ctxFor({}));
    expect(r.status).toBe('INSUFFICIENT_DATA');
  });
});
