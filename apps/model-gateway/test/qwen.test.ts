import { describe, expect, it, vi, afterEach } from 'vitest';
import { ModelGateway } from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Qwen3 4B via Ollama goes through the Model Gateway ONLY. The model name is
// configurable (never hardcoded in agents); the gateway owns validation,
// redaction, audit metadata, and version tracking.
describe('qwen3-4b gateway configuration', () => {
  it('model is configurable to qwen3:4b without code changes', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'synthesis' } }] }) }));
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = fetchMock as unknown as typeof fetch;
    const gw = new ModelGateway({ provider: 'ollama', model: 'qwen3:4b', endpoint: 'http://127.0.0.1:11434', timeout_ms: 120000, generation: { temperature: 0.2, max_tokens: 512 } });
    const r = await gw.chat({ promptName: 'research-synthesis', promptVersion: 'v1', input: 'summarize evidence', caller: 'research-agents', traceId: 't-qwen' });
    expect(r.provider).toBe('ollama');
    expect(r.model).toBe('qwen3:4b');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe('qwen3:4b');
  });

  it('secrets are blocked from LLM prompts and audited', async () => {
    const gw = new ModelGateway({ provider: 'ollama', model: 'qwen3:4b', endpoint: 'http://127.0.0.1:11434', timeout_ms: 1000, generation: { temperature: 0.2, max_tokens: 8 } });
    await expect(gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'api_key=SECRET kite token', caller: 'research-agents', traceId: 't-secret' })).rejects.toThrow(/SECRET_REDACTED/);
    expect(gw.audits[0]).toMatchObject({ model: 'qwen3:4b', redacted: true });
  });

  it('gateway audit records model/version/latency/caller/trace', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = fetchMock as unknown as typeof fetch;
    const gw = new ModelGateway({ provider: 'ollama', model: 'qwen3:4b', endpoint: 'http://127.0.0.1:11434', timeout_ms: 1000, generation: { temperature: 0.2, max_tokens: 8 } });
    await gw.chat({ promptName: 'evidence-summary', promptVersion: 'v2', input: 'bull vs bear', caller: 'analyst-assistant', traceId: 'trace-1' });
    expect(gw.audits[0]).toMatchObject({ provider: 'ollama', model: 'qwen3:4b', promptVersion: 'v2', caller: 'analyst-assistant', traceId: 'trace-1' });
    expect(typeof gw.audits[0]?.latencyMs).toBe('number');
  });

  it('QWEN_UNAVAILABLE surfaces instead of fake success', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('fetch failed'); });
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = fetchMock as unknown as typeof fetch;
    const gw = new ModelGateway({ provider: 'ollama', model: 'qwen3:4b', endpoint: 'http://127.0.0.1:9', timeout_ms: 100, generation: { temperature: 0.2, max_tokens: 8 } });
    await expect(gw.chat({ promptName: 'p', promptVersion: 'v1', input: 'hi', caller: 't', traceId: 'x' })).rejects.toThrow();
  });
});
