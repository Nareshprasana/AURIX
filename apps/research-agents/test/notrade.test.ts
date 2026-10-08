import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { bars, makeResearch, metricEv, NOW, resetResearch } from './helpers.js';

describe('no trading decisions, no broker access', () => {
  beforeEach(resetResearch);

  it('research output contract contains no trade-execution fields', async () => {
    const { orch } = makeResearch();
    const r = await orch.investigate({
      subject: 'company:TCS', objective: 'fundamental growth analysis', agent: 't', actor: 't',
      evidence: [metricEv('revenue', 100, 'Q1', 'r1'), metricEv('revenue', 110, 'Q2', 'r2')],
      now: NOW
    });
    const text = JSON.stringify(r.bundle);
    expect(text).not.toMatch(/\bplaceOrder\b|\bBrokerPort\b|kiteconnect/i);
    expect(r.bundle).not.toHaveProperty('order');
    expect(r.bundle).not.toHaveProperty('position');
    expect(r.bundle).not.toHaveProperty('leverage');
    expect(r.bundle).not.toHaveProperty('allocation');
    const t = await orch.investigate({
      subject: 'company:TCS', objective: 'price trend analysis', agent: 't', actor: 't', bars: bars(25), now: NOW
    });
    expect(JSON.stringify(t.bundle)).not.toMatch(/\border\b/i);
  });

  it('research sources never import broker/execution/risk/portfolio/gateway paths', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${f.name}`;
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts')) files.push(p);
      }
    };
    walk('apps/research-agents/src');
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/@aurix\/(broker-sim|broker-kite|execution-service|risk-engine|portfolio-engine|model-gateway)/);
      expect(src).not.toMatch(/\bplaceOrder\b|BrokerPort|kiteconnect/);
    }
  });
});
