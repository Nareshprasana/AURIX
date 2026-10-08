import { describe, expect, it } from 'vitest';
import { appendKnowledgeEvent, validateKnowledgeEvent } from '../src/index.js';
import type { KnowledgeEvent } from '@aurix/contracts';

function evt(over: Partial<KnowledgeEvent> = {}): KnowledgeEvent {
  return {
    id: 'ke-1', event_type: 'node.upsert', entity_ref: 'n1', payload: { label: 'RELIANCE' },
    actor: 'test', label_class: 'OBSERVATION', evidence_refs: ['ev-1'],
    prev_version: 'v0', new_version: 'v1', device_id: 'dev-1', created_at: Date.now(), ...over
  };
}

describe('knowledge-service', () => {
  it('validates provenance + version chain', () => {
    expect(validateKnowledgeEvent(evt())).toHaveLength(0);
    expect(validateKnowledgeEvent(evt({ evidence_refs: [] })).length).toBeGreaterThan(0);
  });

  it('appends once; duplicates rejected (no silent overwrite)', () => {
    const store = new Map<string, KnowledgeEvent>();
    appendKnowledgeEvent(evt(), (id) => store.has(id), (e) => store.set(e.id, e));
    expect(() => appendKnowledgeEvent(evt(), (id) => store.has(id), (e) => store.set(e.id, e))).toThrow(/duplicate/);
  });

  it('rejects bad label class', () => {
    expect(validateKnowledgeEvent(evt({ label_class: 'TRUTH' as never })).length).toBeGreaterThan(0);
  });
});
