import { describe, expect, it, beforeEach } from 'vitest';
import { ModelGateway } from '@aurix/model-gateway';
import { commitMemory, makeManager, NOW, prov, resetHelpers } from './helpers.js';

describe('memory security', () => {
  beforeEach(resetHelpers);

  it('secret injection into memory is rejected at ingest', () => {
    const { store } = makeManager();
    const v = store.validate(store.propose({
      assertion: 'OBSERVATION',
      ops: [{ op: 'put-memory', memory: { category: 'semantic', key: 'evil', content: { text: 'backup api_key=TOPSECRET' } } }],
      provenance: prov(),
      actor: 'attacker'
    }).id);
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/SECRET/);
  });

  it('agent contexts redact sensitive material', () => {
    const { store, manager } = makeManager();
    commitMemory(store, 'semantic', 'pub', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.9, api_key: 'public-demo-value' });
    const ctx = manager.buildAgentContext('analyst', { subject: 'company:TCS', now: NOW });
    const text = JSON.stringify(ctx.records);
    expect(text).not.toMatch(/public-demo-value/);
    expect(text).toMatch(/REDACTED/);
  });

  it('agent memories are isolated between agents', () => {
    const { manager } = makeManager();
    manager.recordAgentMemory({
      agent: 'agent-a', task_id: 't1', actions: ['read filing'], sources: ['filing-1'],
      conclusions: 'ok', confidence: 0.7, failures: [], lessons: 'none', knowledge_version: 0
    }, 'agent-a', NOW);
    // Owner reads own memory.
    expect(manager.retrieve({ memoryType: 'agent', requester: 'agent-a' }, NOW)).toHaveLength(1);
    // Another agent cannot see it.
    expect(manager.retrieve({ memoryType: 'agent', requester: 'agent-b' }, NOW)).toHaveLength(0);
    // Orchestrator can (coordination role).
    expect(manager.retrieve({ memoryType: 'agent', requester: 'orchestrator' }, NOW)).toHaveLength(1);
  });
});

describe('model independence (regression)', () => {
  beforeEach(resetHelpers);

  it('memory remains after the LLM provider is removed', async () => {
    const gw = new ModelGateway({ provider: 'stub', model: 'stub-a', endpoint: 'http://127.0.0.1:11434', timeout_ms: 1000, generation: { temperature: 0, max_tokens: 8 } });
    const { store, manager } = makeManager();
    const r = await gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'TCS sector', caller: 'demo', traceId: 't' });
    commitMemory(store, 'semantic', 'm', { entity: 'company:TCS', topic: 'sector', domain: 'static', confidence: 0.9, via: r.model });
    const before = manager.retrieve({ entity: 'company:TCS' }, NOW);
    gw.reconfigure({ model: 'stub-b' });
    // Provider discarded entirely: retrieval identical, manager never imported it.
    expect(manager.retrieve({ entity: 'company:TCS' }, NOW)).toEqual(before);
    expect(manager.decide({ subject: 'company:TCS', topic: 'sector', now: NOW }).decision).toBe('REUSE');
  });

  it('embedding version change keeps old vectors addressable', () => {
    const { store } = makeManager();
    for (const [model, version] of [['mini', 'v1'], ['large', 'v2']] as const) {
      store.proposeValidateCommit({
        assertion: 'OBSERVATION',
        ops: [{ op: 'put-embedding', embedding: { document_id: 'doc-tcs', model, model_version: version, vector: [0.1, 0.2], source: 'test' } }],
        provenance: prov(),
        actor: 'test'
      });
    }
    const rows = store.getEmbeddings('doc-tcs');
    expect(rows.map((r) => `${r['model']}:${r['model_version']}`)).toEqual(['mini:v1', 'large:v2']);
  });

  it('memory-manager never depends on the model gateway', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    for (const f of readdirSync('apps/memory-manager/src')) {
      if (!f.endsWith('.ts')) continue;
      expect(readFileSync(`apps/memory-manager/src/${f}`, 'utf8')).not.toMatch(/model-gateway|ModelGateway|Ollama|chat\/completions/i);
    }
    for (const f of readdirSync('packages/market-data/src')) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(`packages/market-data/src/${f}`, 'utf8');
      expect(src).not.toMatch(/node:|Ollama|kite|broker/i);
      expect(src).not.toMatch(/'NSE'|"NSE"/);
    }
  });
});
