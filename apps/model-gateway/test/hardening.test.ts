import { describe, expect, it, vi, afterEach } from 'vitest';
import { GatewayError, ModelGateway } from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function gw(over: Record<string, unknown> = {}) {
  return new ModelGateway({
    provider: 'ollama', model: 'qwen3:4b', endpoint: 'http://127.0.0.1:11434',
    timeout_ms: 5000, generation: { temperature: 0.2, max_tokens: 64 }, ...over
  } as never);
}

const req = { promptName: 'p', promptVersion: 'v1', input: 'hello', caller: 't', traceId: 'x' };

describe('gateway hardening (P1-4)', () => {
  it('enforces timeout_ms and classifies MODEL_TIMEOUT without hanging', async () => {
    const hanging = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise((_r, rej) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          rej(e);
        });
      });
      throw new Error('unreachable');
    });
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = hanging as unknown as typeof fetch;
    const g = gw({ timeout_ms: 50, maxRetries: 0 });
    await expect(g.chat(req)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', attempts: 1 });
    expect(g.audits[0]).toMatchObject({ errorCode: 'MODEL_TIMEOUT' });
  });

  it('retries 503 with backoff then succeeds, recording attempts', async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    });
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = flaky as unknown as typeof fetch;
    const g = gw({ maxRetries: 2 });
    const r = await g.chat(req);
    expect(r.text).toBe('ok');
    expect(calls).toBe(2);
    expect(g.audits[0]).toMatchObject({ attempts: 2 });
  });

  it('does not retry 4xx or MODEL_UNAVAILABLE', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }));
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = bad as unknown as typeof fetch;
    await expect(gw({ maxRetries: 3 }).chat(req)).rejects.toMatchObject({ code: 'MODEL_UPSTREAM' });
    expect(bad).toHaveBeenCalledOnce();
  });

  it('rejects malformed/empty upstream content as MODEL_MALFORMED', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: '' } }] }]) {
      const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
      (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = f as unknown as typeof fetch;
      await expect(gw().chat(req)).rejects.toMatchObject({ code: 'MODEL_MALFORMED' });
    }
    expect(gw().audits).toHaveLength(0);
  });

  it('rejects oversized input before any network call', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }));
    (globalThis as { __aurixFetch?: typeof fetch }).__aurixFetch = f as unknown as typeof fetch;
    await expect(gw({ maxInputChars: 10 }).chat({ ...req, input: '12345678901' }))
      .rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' });
    expect(f).not.toHaveBeenCalled();
  });

  it('GatewayError carries code, attempts and retryable flag', () => {
    const e = new GatewayError('MODEL_UPSTREAM', 'x', 2, true);
    expect(e.retryable).toBe(true);
    expect(new GatewayError('MODEL_MALFORMED', 'y').retryable).toBe(false);
  });
});
