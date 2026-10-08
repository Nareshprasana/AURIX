import { describe, expect, it, beforeEach } from 'vitest';
import { earningsEvent } from '@aurix/market-data';
import { advance, bars, makeResearch, metricEv, NOW, resetResearch } from './helpers.js';

describe('orchestrator memory outcomes', () => {
  beforeEach(resetResearch);

  it('RESEARCH on first request, REUSE on second (no agent rerun)', () => {
    const { orch } = makeResearch();
    const evidence = [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')];
    const first = orch.investigate({ subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 'tester', actor: 'tester', evidence, now: NOW });
    return first.then((r1) => {
      expect(r1.path).toBe('RESEARCH');
      expect(r1.agentsRun).toContain('fundamental');
      expect(r1.bundle?.status).toBe('COMPLETED');
      return orch.investigate({ subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 'tester', actor: 'tester', evidence, now: NOW + 1000 }).then((r2) => {
        expect(r2.path).toBe('REUSE');
        expect(r2.agentsRun).toHaveLength(0);
        expect(r2.bundle?.task_id).toBe(r1.bundle?.task_id);
      });
    });
  });

  it('stale memory → REFRESH with only affected work rerun', () => {
    const { orch } = makeResearch();
    const evidence = [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')];
    return orch.investigate({ subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 'tester', actor: 'tester', evidence, now: NOW }).then(() => {
      advance(200 * 24 * 3600_000);
      return orch.investigate({ subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 'tester', actor: 'tester', evidence, now: NOW + 200 * 24 * 3600_000 }).then((r) => {
        expect(r.path).toBe('REFRESH');
        expect(r.agentsRun).toContain('fundamental');
      });
    });
  });

  it('contradiction without new evidence → CONFLICT path, nothing rerun', () => {
    const { memory, orch } = makeResearch();
    memory.recordAgentMemory({
      agent: 'tester', task_id: 't1', actions: [], sources: [], conclusions: 'up', confidence: 0.8,
      failures: [], lessons: 'none', knowledge_version: 0, entity: 'company:TCS', topic: 'sentiment', view: 'up'
    }, 'tester', NOW);
    memory.recordAgentMemory({
      agent: 'tester', task_id: 't2', actions: [], sources: [], conclusions: 'down', confidence: 0.8,
      failures: [], lessons: 'none', knowledge_version: 0, entity: 'company:TCS', topic: 'sentiment', view: 'down'
    }, 'tester', NOW);
    return orch.investigate({ subject: 'company:TCS', objective: 'sentiment check', agent: 'tester', actor: 'tester', now: NOW }).then((r) => {
      expect(r.path).toBe('CONFLICT');
      expect(r.agentsRun).toHaveLength(0);
    });
  });

  it('unknown topics → INSUFFICIENT without agent runs', () => {
    const { orch } = makeResearch();
    return orch.investigate({ subject: 'company:TCS', objective: 'quantum astrology outlook', agent: 'tester', actor: 'tester', now: NOW }).then((r) => {
      expect(r.path).toBe('INSUFFICIENT');
      expect(r.agentsRun).toHaveLength(0);
    });
  });

  it('selective execution: price question runs only the technical agent', () => {
    const { orch } = makeResearch();
    return orch.investigate({ subject: 'company:TCS', objective: 'price trend analysis', agent: 'tester', actor: 'tester', bars: bars(25), now: NOW }).then((r) => {
      expect(r.agentsRun).toEqual(['technical']);
      expect(r.bundle?.observations.length).toBeGreaterThan(0);
    });
  });

  it('event refresh targets only dependent research', () => {
    const { orch } = makeResearch();
    const fundEvidence = [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')];
    return orch.investigate({ subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 'tester', actor: 'tester', evidence: fundEvidence, now: NOW }).then(() =>
      orch.investigate({ subject: 'company:INFY', objective: 'price trend analysis', agent: 'tester', actor: 'tester', bars: bars(25), now: NOW }).then(() => {
        const ev = earningsEvent(['TCS'], NOW + 1000, NOW + 1000, 'exchange');
        ev.entity_refs = ['company:TCS'];
        return orch.refreshForEvent(ev, 'tester', NOW + 1000).then((res) => {
          expect(res.refreshed.length).toBe(1);
          expect(res.refreshed[0]?.task_id).toMatch(/^task-/);
          expect(res.refreshed[0]?.outcome.path).toBe('REFRESH');
        });
      })
    );
  });
});
