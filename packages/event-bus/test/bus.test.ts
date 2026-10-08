import { describe, expect, it, beforeEach } from 'vitest';
import { EventBus } from '../src/index.js';
import { MemoryStore } from './memory-store.js';

describe('event-bus', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus(new MemoryStore());
  });

  it('publishes an event', () => {
    const e = bus.publish('data.collected', { x: 1 });
    expect(e.type).toBe('data.collected');
    expect(e.status).toBe('PENDING');
  });

  it('claim + ack completes work', () => {
    const e = bus.publish('research.completed', { ok: true });
    const claimed = bus.claim(['research.completed'], 'worker-a');
    expect(claimed.map((c) => c.id)).toContain(e.id);
    bus.ack(e.id);
    expect(bus.get(e.id)?.status).toBe('DONE');
  });

  it('failure then retry re-queues', () => {
    const e = bus.publish('risk.verdict', {});
    bus.claim(['risk.verdict'], 'w');
    bus.fail(e.id, 'boom');
    expect(bus.get(e.id)?.status).toBe('FAILED');
    const retry = bus.claim(['risk.verdict'], 'w');
    expect(retry.map((c) => c.id)).toContain(e.id);
    expect(bus.get(e.id)?.attempts).toBeGreaterThanOrEqual(2);
  });

  it('idempotent publish returns the original event', () => {
    const a = bus.publish('execution.requested', { o: 1 }, { idempotencyKey: 'k-1' });
    const b = bus.publish('execution.requested', { o: 1 }, { idempotencyKey: 'k-1' });
    expect(b.id).toBe(a.id);
  });

  it('claim filters by type', () => {
    bus.publish('a', {});
    const b = bus.publish('b', {});
    const claimed = bus.claim(['b'], 'w');
    expect(claimed.map((c) => c.id)).toContain(b.id);
    expect(claimed.every((c) => c.type === 'b')).toBe(true);
  });
});
