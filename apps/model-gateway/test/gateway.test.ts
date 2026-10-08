import { describe, expect, it, vi, afterEach } from 'vitest';
import { ModelGateway } from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model-gateway', () => {
  it('stub provider returns deterministic text', async () => {
    const gw = new ModelGateway({ provider: 'stub', model: 'stub-echo-v1', endpoint: 'http://127.0.0.1:11434', timeout_ms: 5000, generation: { temperature: 0.2, max_tokens: 64 } });
    const r = await gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'hello', caller: 'test', traceId: 't1' });
    expect(r.provider).toBe('stub');
    expect(r.model).toBe('stub-echo-v1');
    expect(gw.audits).toHaveLength(1);
  });

  it('ollama provider uses OpenAI-compatible interface shape', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }));
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = fetchMock as unknown as typeof fetch;
    const gw = new ModelGateway({ provider: 'ollama', model: 'any-model', endpoint: 'http://127.0.0.1:11434', timeout_ms: 5000, generation: { temperature: 0.1, max_tokens: 32 } });
    const r = await gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'hello', caller: 'test', traceId: 't2' });
    expect(r.provider).toBe('ollama');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/chat\/completions$/);
    expect(JSON.parse(String(init.body)).model).toBe('any-model');
  });

  it('redacts secrets and audits the block', async () => {
    const gw = new ModelGateway({ provider: 'stub', model: 'stub-echo-v1', endpoint: 'http://127.0.0.1:11434', timeout_ms: 5000, generation: { temperature: 0.2, max_tokens: 64 } });
    await expect(gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'my api_key=XYZ kite secret', caller: 'evil', traceId: 't3' })).rejects.toThrow(/SECRET_REDACTED/);
    expect(gw.audits[0]?.redacted).toBe(true);
  });

  it('audit logging records provider/model/caller/trace', async () => {
    const gw = new ModelGateway({ provider: 'stub', model: 'm', endpoint: 'e', timeout_ms: 1, generation: { temperature: 0, max_tokens: 1 } });
    await gw.chat({ promptName: 'n', promptVersion: 'v3', input: 'x', caller: 'research', traceId: 'abc' });
    const a = gw.audits[0];
    expect(a).toMatchObject({ provider: 'stub', model: 'm', promptVersion: 'v3', caller: 'research', traceId: 'abc' });
  });

  it('model replacement needs no schema migration (config-only swap)', async () => {
    const gw = new ModelGateway({ provider: 'stub', model: 'model-a', endpoint: 'e', timeout_ms: 1, generation: { temperature: 0, max_tokens: 1 } });
    const r1 = await gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'hello', caller: 't', traceId: '1' });
    gw.reconfigure({ provider: 'stub', model: 'model-b' });
    const r2 = await gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'hello', caller: 't', traceId: '2' });
    expect(r1.model).toBe('model-a');
    expect(r2.model).toBe('model-b');
  });

  it('reports MODEL_UNAVAILABLE instead of downloading', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = fetchMock as unknown as typeof fetch;
    const gw = new ModelGateway({ provider: 'ollama', model: 'missing-model', endpoint: 'http://127.0.0.1:11434', timeout_ms: 5000, generation: { temperature: 0, max_tokens: 1 } });
    await expect(gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'hi', caller: 't', traceId: 'x' })).rejects.toThrow(/MODEL_UNAVAILABLE/);
  });
});
