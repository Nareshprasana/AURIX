import { describe, expect, it, beforeEach } from 'vitest';
import { TechnicalAgent } from '../src/index.js';
import type { AgentContext } from '../src/index.js';
import { bars, NOW, resetResearch } from './helpers.js';

function ctxFor(over: Partial<AgentContext> = {}): AgentContext {
  return {
    task: { task_id: 'task-t', subject: 'company:TCS', objective: 'test', scope: 'test', agent: 'tester' },
    memories: [],
    evidence: [],
    events: [],
    bars: [],
    quotes: [],
    gaps: [],
    qualityNotes: [],
    now: NOW,
    ...over
  };
}

describe('technical agent', () => {
  beforeEach(resetResearch);

  it('computes trend/momentum/volatility/S-R/drawdown from OHLCV', async () => {
    const agent = new TechnicalAgent();
    const r = await agent.run(ctxFor({ bars: bars(25, 100) }));
    expect(r.status).toBe('COMPLETED');
    const statements = r.observations.map((o) => o.statement).join(' ');
    expect(statements).toMatch(/trend = (bullish|bearish|neutral)/);
    expect(statements).toMatch(/momentum = /);
    expect(statements).toMatch(/volatility = /);
    expect(statements).toMatch(/support = /);
    expect(statements).toMatch(/drawdown = /);
    expect(r.conclusions.join(' ')).toMatch(/no trade direction implied/i);
  });

  it('records input range, timeframe and quality', async () => {
    const agent = new TechnicalAgent();
    const r = await agent.run(ctxFor({ bars: bars(25, 100) }));
    expect(r.assumptions.join(' ')).toMatch(/1D/);
    expect(r.observations.every((o) => o.data_quality === 'VALID')).toBe(true);
  });

  it('rejects quarantined data instead of using it', async () => {
    const agent = new TechnicalAgent();
    const bad = bars(25, 100).map((b) => ({ ...b, close: -1 }));
    const r = await agent.run(ctxFor({ bars: bad }));
    expect(r.status).toBe('DATA_QUARANTINED');
    expect(r.observations).toHaveLength(0);
  });

  it('reports missing data and short history honestly', async () => {
    const agent = new TechnicalAgent();
    const empty = await agent.run(ctxFor({}));
    expect(empty.status).toBe('INSUFFICIENT_DATA');
    const short = await agent.run(ctxFor({ bars: bars(8, 100) }));
    expect(short.status).toBe('COMPLETED');
    expect(short.missing.join(' ')).toMatch(/SMA20/);
  });

  it('never emits trade decisions', async () => {
    const agent = new TechnicalAgent();
    const r = await agent.run(ctxFor({ bars: bars(25, 100) }));
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/\bplaceOrder\b|\bBrokerPort\b/i);
    expect(r).not.toHaveProperty('order');
    expect(r).not.toHaveProperty('positionSize');
  });
});
