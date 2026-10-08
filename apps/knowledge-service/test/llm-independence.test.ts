import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { ModelGateway } from '@aurix/model-gateway';
import { makeStore, nodeInput, prov, resetFixtures } from './fixtures.js';

describe('LLM independence', () => {
  beforeEach(resetFixtures);

  it('knowledge survives model swap and provider removal', async () => {
    const gw = new ModelGateway({ provider: 'stub', model: 'model-a', endpoint: 'http://127.0.0.1:11434', timeout_ms: 1000, generation: { temperature: 0, max_tokens: 16 } });
    const store = makeStore();
    const r1 = await gw.chat({ promptName: 'extract', promptVersion: 'v1', input: 'RELIANCE sector Energy', caller: 'research', traceId: 't1' });
    store.proposeValidateCommit(nodeInput('company:RELIANCE', { sector: 'Energy' }, 'OBSERVATION', prov({ model: r1.model, prompt_version: 'v1' })));
    const before = store.snapshotCanonical();

    gw.reconfigure({ model: 'model-b' });
    const r2 = await gw.chat({ promptName: 'extract', promptVersion: 'v1', input: 'TCS sector IT', caller: 'research', traceId: 't2' });
    expect(r2.model).toBe('model-b');
    store.proposeValidateCommit(nodeInput('company:TCS', { sector: 'IT' }, 'OBSERVATION', prov({ model: r2.model, prompt_version: 'v1' })));

    // Provider removed: knowledge remains fully queryable.
    expect(store.getEntity('company:RELIANCE')?.data).toEqual({ sector: 'Energy' });
    expect(store.getEntity('company:TCS')?.data).toEqual({ sector: 'IT' });
    expect(store.snapshotCanonical()).toContain('company:RELIANCE');
    expect(before).toContain('company:RELIANCE');
    expect(store.knowledgeVersion()).toBe(2);
  });

  it('knowledge-service never depends on the model gateway', () => {
    const dir = 'apps/knowledge-service/src';
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(`${dir}/${f}`, 'utf8');
      expect(src).not.toMatch(/model-gateway|ModelGateway|chat\/completions|Ollama/i);
    }
  });
});
