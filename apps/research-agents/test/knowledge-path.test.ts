import { describe, expect, it, beforeEach } from 'vitest';
import { bars, makeResearch, metricEv, NOW, resetResearch } from './helpers.js';

describe('research knowledge path', () => {
  beforeEach(resetResearch);

  it('research commits proposals through validation', async () => {
    const { store, orch } = makeResearch();
    const kv0 = store.knowledgeVersion();
    const r = await orch.investigate({
      subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 't', actor: 't',
      evidence: [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')], now: NOW
    });
    expect(r.bundle).not.toBeNull();
    expect(store.knowledgeVersion()).toBeGreaterThan(kv0);
    expect(r.bundle?.knowledge_refs.length).toBeGreaterThan(0);
  });

  it('bundle retains provenance and versioning', async () => {
    const { store, orch } = makeResearch();
    const r = await orch.investigate({
      subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 't', actor: 't',
      evidence: [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')], now: NOW
    });
    const node = store.getEntity(`research:${r.task_id}`);
    expect(node).toBeDefined();
    expect(store.provenanceChain(`research:${r.task_id}`).length).toBeGreaterThan(0);
    expect(node?.version).toBe(1);
  });

  it('agent FACT suggestions never land as FACT without corroboration', () => {
    const { store } = makeResearch();
    // Direct store check: a lone agent-typed FACT claim is rejected by policy.
    const v = store.validate(store.propose({
      assertion: 'FACT',
      ops: [{ op: 'upsert-node', node: { id: 'company:Z', kind: 'Company', label: 'z', data: {} } }],
      provenance: { source: 'agent', source_type: 'agent', source_identifier: 'agent-x', observed_at: NOW, agent: 'x', evidence_refs: ['e'], confidence: 0.9 },
      actor: 'x'
    }).id);
    expect(v.state).toBe('REJECTED');
  });

  it('orchestrator coerces agent FACT refs to INFERENCE', async () => {
    const { store, memory } = makeResearch();
    const { ResearchOrchestrator } = await import('../src/index.js');
    const coercing = {
      id: 'factoid',
      topics: ['factoid'],
      run: async (ctx: { task: { task_id: string }; now: number }) => ({
        research_task_id: ctx.task.task_id, agent: 'factoid', subject: 'company:TCS', status: 'COMPLETED' as const,
        observations: [], evidence: [], sources: ['s'], methodology: 'm', assumptions: [], contradictions: [],
        conclusions: ['c'], confidence: 0.9,
        knowledge_proposals: [{ assertion: 'FACT' as const, summary: 'unsupported fact', entity_refs: ['company:TCS'] }],
        missing: [], created_at: ctx.now
      })
    };
    const orch2 = new ResearchOrchestrator(store, memory, [coercing]);
    await orch2.investigate({ subject: 'company:TCS', objective: 'factoid check', agent: 't', actor: 't', now: NOW });
    const coerced = store.snapshotNodes().filter((n) => (n.data as Record<string, unknown>)['coerced'] === true);
    expect(coerced.length).toBeGreaterThan(0);
    expect(coerced.every((n) => n.label_class === 'INFERENCE')).toBe(true);
  });

  it('result bundle records dependencies for scoped refresh', async () => {
    const { orch } = makeResearch();
    const r = await orch.investigate({
      subject: 'company:TCS', objective: 'price trend analysis', agent: 't', actor: 't', bars: bars(25), now: NOW
    });
    expect(r.bundle?.depends_on).toContain('company:TCS');
  });
});
