import { describe, expect, it, beforeEach } from 'vitest';
import { earningsEvent } from '@aurix/market-data';
import { commitMemory, makeManager, NOW, prov, resetHelpers } from './helpers.js';

/** Minimal demonstration agent (test-only): retrieve → decide → task → store. */
function demoAsk(
  ctx: ReturnType<typeof makeManager>,
  subject: string,
  topic: string,
  now: number
): { decision: string; answered: boolean } {
  const d = ctx.manager.decide({ subject, topic, agent: 'demo-agent', now });
  if (d.decision === 'REUSE') return { decision: d.decision, answered: true };
  if (d.decision === 'RESEARCH' || d.decision === 'REFRESH') {
    const reg = ctx.manager.registerTask({ subject, objective: topic, scope: 'demo', agent: 'demo-agent', actor: 'demo', now });
    if (!reg.deduplicated) {
      ctx.store.proposeValidateCommit({
        assertion: 'OBSERVATION',
        ops: [{ op: 'put-memory', memory: { category: 'semantic', key: `${topic}:${subject}`, content: { entity: subject, topic, domain: 'research', confidence: 0.85, answer: `${topic} of ${subject}` } } }],
        provenance: prov({ source_identifier: `demo-${subject}-${topic}` }),
        actor: 'demo-agent'
      });
      ctx.manager.completeTask(reg.task.task_id, `memory:${topic}:${subject}`, 'COMPLETED', 'demo-agent', now);
    }
    return { decision: reg.deduplicated ? 'REUSED_TASK' : d.decision, answered: true };
  }
  return { decision: d.decision, answered: false };
}

describe('phase 4 demonstration (§33 proof)', () => {
  beforeEach(resetHelpers);

  it('RESEARCH → store → REUSE → event → REFRESH → conflict → CONFLICT', () => {
    const ctx = makeManager();
    // 1. No memory → RESEARCH_REQUIRED.
    const first = demoAsk(ctx, 'company:X', 'sector', NOW);
    expect(first.decision).toBe('RESEARCH');
    // 2. Second request → REUSE.
    const second = demoAsk(ctx, 'company:X', 'sector', NOW + 1000);
    expect(second.decision).toBe('REUSE');
    // 3. New Company X event → REFRESH_REQUIRED.
    const ev = earningsEvent(['X'], NOW + 2000, NOW + 2000, 'exchange', { quarter: 'Q3' });
    ctx.manager.applyMarketEvent({ ...ev, entity_refs: ['company:X'] }, 'demo-agent', NOW + 2000);
    const third = ctx.manager.decide({ subject: 'company:X', topic: 'sector', agent: 'demo-agent', now: NOW + 2000 });
    expect(third.decision).toBe('REFRESH');
    // 4. Conflicting evidence → CONFLICT, no silent overwrite.
    commitMemory(ctx.store, 'semantic', 'c1', { entity: 'company:X', topic: 'sentiment', domain: 'research', confidence: 0.8, view: 'up' });
    commitMemory(ctx.store, 'semantic', 'c2', { entity: 'company:X', topic: 'sentiment', domain: 'research', confidence: 0.8, view: 'down' });
    const fourth = ctx.manager.decide({ subject: 'company:X', topic: 'sentiment', agent: 'demo-agent', now: NOW + 2000 });
    expect(fourth.decision).toBe('CONFLICT');
  });

  it('demo agent avoids duplicate research via task registry', () => {
    const ctx = makeManager();
    const r1 = demoAsk(ctx, 'company:Y', 'valuation', NOW);
    const r2 = demoAsk(ctx, 'company:Y', 'valuation', NOW + 500);
    expect(r1.decision).toBe('RESEARCH');
    expect(r2.decision).toBe('REUSE');
    expect(ctx.manager.findTasks({ subject: 'company:Y' })).toHaveLength(1);
  });
});
