import { describe, expect, it } from 'vitest';
import { gatewayInterpreter, interpreterForAgent, DEFAULT_INTERPRETER_POLICY } from '../src/interpreter.js';
import { ModelGateway } from '../src/index.js';

function stubGw() {
  return new ModelGateway({ provider: 'stub', model: 'stub-echo-v1', endpoint: 'e', timeout_ms: 1000, generation: { temperature: 0, max_tokens: 32 } });
}

describe('gateway interpreter wiring (P1-5)', () => {
  it('adapts the gateway to the interpreter shape with audit trail', async () => {
    const gw = stubGw();
    const interp = gatewayInterpreter(gw);
    const r = await interp.interpret('fundamental-summary', 'bullishBias 0.6');
    expect(r.model).toBe('stub-echo-v1');
    expect(r.text).toContain('fundamental-summary');
    expect(gw.audits).toHaveLength(1);
    expect(gw.audits[0]).toMatchObject({ caller: 'research-agents', promptName: 'agent-interpretation' });
  });

  it('defaults to fundamental-only; other agents get undefined (no auto-enable)', () => {
    const interp = gatewayInterpreter(stubGw());
    expect(interpreterForAgent('fundamental', interp)?.interpret).toBeTypeOf('function');
    expect(interpreterForAgent('technical', interp)).toBeUndefined();
    expect(interpreterForAgent('fundamental', undefined)).toBeUndefined();
    expect(DEFAULT_INTERPRETER_POLICY.allowedAgents).toEqual(['fundamental']);
  });

  it('gateway failures propagate as GatewayError, never silent text', async () => {
    const gw = stubGw();
    gw.reconfigure({ provider: 'ollama', model: 'gone', endpoint: 'http://127.0.0.1:9' });
    const interp = gatewayInterpreter(gw);
    await expect(interp.interpret('p', 'i')).rejects.toThrow();
  });
});
