import { describe, expect, it } from 'vitest';
import { redact } from '../src/index.js';

describe('observability', () => {
  it('redacts secret-bearing fields', () => {
    const out = redact({ api_key: 'XYZ', note: 'hello', nested: { kite_token: 'abc' } }) as Record<string, unknown>;
    expect(out['api_key']).toBe('[REDACTED]');
    expect(out['note']).toBe('hello');
    expect((out['nested'] as Record<string, unknown>)['kite_token']).toBe('[REDACTED]');
  });
});
