import { describe, expect, it, beforeEach } from 'vitest';
import { advance, makeManager, NOW, resetHelpers } from './helpers.js';

const TASK = { subject: 'company:TCS', scope: 'Q3FY26', agent: 'demo-agent', actor: 'tester' };

describe('research deduplication', () => {
  beforeEach(resetHelpers);

  it('identical task reuses the existing registration', () => {
    const { manager } = makeManager();
    const first = manager.registerTask({ ...TASK, objective: 'latest earnings', now: NOW });
    expect(first.deduplicated).toBe(false);
    const second = manager.registerTask({ ...TASK, objective: 'latest earnings', now: NOW + 1000 });
    expect(second.deduplicated).toBe(true);
    expect(second.task.task_id).toBe(first.task.task_id);
  });

  it('similar task is found via similarity search', () => {
    const { manager } = makeManager();
    manager.registerTask({ ...TASK, objective: 'latest earnings', now: NOW });
    const similar = manager.findSimilar({ subject: 'company:TCS', objective: 'latest quarterly results', scope: 'Q3FY26' });
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0]!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(similar[0]?.task.objective).toBe('latest earnings');
  });

  it('different task registers independently', () => {
    const { manager } = makeManager();
    const a = manager.registerTask({ ...TASK, objective: 'latest earnings', now: NOW });
    const b = manager.registerTask({ ...TASK, objective: 'promoter holdings', now: NOW });
    expect(a.task.task_id).not.toBe(b.task.task_id);
    expect(manager.findSimilar({ subject: 'company:TCS', objective: 'promoter holdings pledge status', scope: 'Q3FY26' })[0]?.task.objective).toBe('promoter holdings');
  });

  it('expired task result becomes eligible for refresh, history preserved', () => {
    const { store, manager } = makeManager();
    const first = manager.registerTask({ ...TASK, objective: 'valuation', now: NOW });
    manager.completeTask(first.task.task_id, 'node:valuation-v1', 'COMPLETED', 'tester', NOW);
    // 60 days later: research-domain result is STALE → new registration, old kept.
    const second = manager.registerTask({ ...TASK, objective: 'valuation', now: NOW + 60 * 24 * 3600_000 });
    expect(second.deduplicated).toBe(false);
    expect(second.task.task_id).not.toBe(first.task.task_id);
    const history = manager.findTasks({ subject: 'company:TCS' });
    expect(history.map((t) => t.status)).toContain('COMPLETED');
    expect(store.getEntity(first.task.task_id)?.version).toBe(2);
    void advance;
  });
});
