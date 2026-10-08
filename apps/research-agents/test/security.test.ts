import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { bars, makeResearch, metricEv, NOW, resetResearch } from './helpers.js';

describe('research security', () => {
  beforeEach(resetResearch);

  it('knowledge → memory → context → interpreter path cannot leak secrets', async () => {
    const { orch } = makeResearch();
    // A secret-bearing evidence item is excluded at intake and named, never used.
    const r = await orch.investigate({
      subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 'analyst', actor: 'analyst',
      evidence: [
        metricEv('revenue', 100, 'Q1', 'r1'),
        { ...metricEv('revenue', 110, 'Q2', 'r2'), source_identifier: 'filing-r2 api_key=LEAKME' }
      ],
      interpreter: {
        interpret: async (prompt, input) => {
          if (/LEAKME|api_key/i.test(`${prompt} ${input}`)) throw new Error('INTERPRETER_SAW_SECRET');
          return { text: 'ok', model: 'stub' };
        }
      },
      now: NOW
    });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/LEAKME/);
    expect(r.bundle?.sources_excluded).toContain('ev-r2');
  });

  it('agent contexts enforce ACL (researcher cannot read another agent memory)', async () => {
    const { memory } = makeResearch();
    memory.recordAgentMemory({
      agent: 'agent-a', task_id: 't1', actions: [], sources: [], conclusions: 'private', confidence: 0.7,
      failures: [], lessons: 'none', knowledge_version: 0
    }, 'agent-a', NOW);
    const ctx = memory.buildAgentContext('agent-b', { subject: 'company:TCS', now: NOW });
    expect(JSON.stringify(ctx.records)).not.toMatch(/private/);
  });

  it('research agents are isolated from gateway/broker/risk/execution', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${f.name}`;
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts')) files.push(p);
      }
    };
    walk('apps/research-agents/src');
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/from\s+['"]@aurix\/(model-gateway|broker-sim|broker-kite|execution-service|risk-engine|portfolio-engine)['"]/);
      expect(src).not.toMatch(/\bplaceOrder\b|BrokerPort|kiteconnect/);
    }
  });
});
