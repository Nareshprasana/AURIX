import { describe, expect, it, beforeEach } from 'vitest';
import { ResearchOrchestrator } from '../src/index.js';
import type { ResearchAgent } from '../src/index.js';
import { bars, makeResearch, metricEv, NOW, resetResearch } from './helpers.js';

const boom: ResearchAgent = {
  id: 'boom',
  topics: ['boom'],
  run: async () => {
    throw new Error('provider exploded');
  }
};

const hanging: ResearchAgent = {
  id: 'hanger',
  topics: ['hanger'],
  run: () => new Promise<never>(() => undefined)
};

describe('research failure handling', () => {
  beforeEach(resetResearch);

  it('MODEL_UNAVAILABLE when required interpretation is absent; degraded gracefully when it throws', async () => {
    makeResearch();
    const { FundamentalAgent } = await import('../src/index.js');
    const agent = new FundamentalAgent();
    const base = {
      task: { task_id: 't', subject: 'company:TCS', objective: 'o', scope: 's', agent: 't' },
      memories: [], evidence: [metricEv('revenue', 100, 'Q1', 'r1')], events: [], bars: [], quotes: [],
      gaps: [], qualityNotes: [], now: NOW
    };
    const unavailable = await agent.run({ ...base, llmRequired: true });
    expect(unavailable.status).toBe('MODEL_UNAVAILABLE');
    const degraded = await agent.run({
      ...base,
      interpreter: { interpret: async () => { throw new Error('gateway down'); } }
    });
    expect(degraded.status).toBe('COMPLETED');
    expect(degraded.assumptions.join(' ')).toMatch(/unavailable/);
  });

  it('hanging agent hits TIMEOUT; siblings continue → PARTIAL bundle', async () => {
    const { store, memory } = makeResearch();
    const { TechnicalAgent } = await import('../src/index.js');
    const orch = new ResearchOrchestrator(store, memory, [new TechnicalAgent(), hanging]);
    const r = await orch.investigate({
      subject: 'company:TCS', objective: 'price trend hanger review', agent: 't', actor: 't',
      bars: bars(25), timeoutMs: 20, now: NOW
    });
    expect(r.agentsRun).toContain('hanger');
    expect(r.bundle?.status).toBe('PARTIAL');
    expect(r.bundle?.agent_results.find((x) => x.agent === 'hanger')?.status).toBe('TIMEOUT');
  });

  it('QUARANTINED-only data yields DATA_QUARANTINED with zero observations', async () => {
    const { store, memory } = makeResearch();
    const { TechnicalAgent } = await import('../src/index.js');
    const orch = new ResearchOrchestrator(store, memory, [new TechnicalAgent()]);
    const bad = bars(25, 100).map((b) => ({ ...b, close: -1 }));
    const r = await orch.investigate({ subject: 'company:TCS', objective: 'price trend review', agent: 't', actor: 't', bars: bad, now: NOW });
    expect(r.bundle?.status).toBe('DATA_QUARANTINED');
    expect(r.bundle?.observations).toHaveLength(0);
  });

  it('throwing agent → FAILED stub; bundle PARTIAL; no authoritative observations from it', async () => {
    const { store, memory } = makeResearch();
    const { TechnicalAgent } = await import('../src/index.js');
    const orch = new ResearchOrchestrator(store, memory, [new TechnicalAgent(), boom]);
    const r = await orch.investigate({
      subject: 'company:TCS', objective: 'price trend boom review', agent: 't', actor: 't', bars: bars(25), now: NOW
    });
    expect(r.bundle?.status).toBe('PARTIAL');
    expect(r.bundle?.agent_results.find((x) => x.agent === 'boom')?.status).toBe('FAILED');
    expect(r.bundle?.observations.every((o) => !o.observation_id.includes('boom'))).toBe(true);
  });
});
