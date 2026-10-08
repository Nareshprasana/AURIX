import { describe, expect, it, beforeEach } from 'vitest';
import { commitMemory, makeManager, NOW, resetHelpers } from './helpers.js';

describe('resource efficiency (reuse cheaper than research)', () => {
  beforeEach(resetHelpers);

  it('retrieval over 500 records stays within generous bounds', () => {
    const { store, manager } = makeManager();
    for (let i = 0; i < 500; i++) {
      commitMemory(store, 'semantic', `k-${i}`, { entity: `company:C${i % 50}`, topic: `topic-${i % 10}`, domain: 'static', confidence: 0.8 });
    }
    const start = Date.now();
    const hits = manager.retrieve({ entity: 'company:C7' }, NOW);
    const elapsed = Date.now() - start;
    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
    // Repeat lookup is a scan, not new research: same count, candidate evidence ready.
    const d = manager.decide({ subject: 'company:C7', now: NOW });
    expect(d.candidates.length).toBeGreaterThan(0);
  });

  it('dedup lookup avoids re-registration work', () => {
    const { manager } = makeManager();
    const first = manager.registerTask({ subject: 'company:Z', objective: 'brief', scope: 's', agent: 'a', actor: 't', now: NOW });
    const start = Date.now();
    const second = manager.registerTask({ subject: 'company:Z', objective: 'brief', scope: 's', agent: 'a', actor: 't', now: NOW });
    const elapsed = Date.now() - start;
    expect(second.deduplicated).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    expect(first.task.task_id).toBe(second.task.task_id);
  });
});
