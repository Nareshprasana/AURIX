import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { KnowledgeStore, MemoryTables } from '@aurix/knowledge-service';
import { MemoryManager } from '@aurix/memory-manager';
import { PortfolioService } from '../src/index.js';
import type { DataQualityMap, MarketSnapshot, PipelineRequest, PortfolioCandidate, PositionView } from '@aurix/portfolio';

let tick = 5_000_000_000_000;

function setup() {
  const tables = new MemoryTables();
  const store = new KnowledgeStore(tables, { deviceId: 'dev-port', now: () => tick });
  const memory = new MemoryManager(store);
  const service = new PortfolioService(store, memory);
  return { store, memory, service };
}

function cand(id: string, over: Partial<PortfolioCandidate> = {}): PortfolioCandidate {
  return {
    candidate_id: `cand-${id}`,
    instrument: { instrument_id: id, exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: id },
    strategy_id: 'test:roc',
    strategy_version: 1,
    signal_type: 'LONG',
    signal_strength: 0.8,
    signal_confidence: 0.7,
    expected_horizon_bars: 5,
    evidence_refs: [],
    regime: 'up_low',
    liquidity: { adv_value: 100_000_000, spread_bps: 5, volume: 1_000_000 },
    direction: 1,
    reference_price: 100,
    invalidation: [`instrument:${id}`],
    ...over
  };
}

function market(ids: string[], over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const prices: Record<string, number> = {};
  const volumes: Record<string, number> = {};
  const adv: Record<string, number | null> = {};
  const spreads: Record<string, number | null> = {};
  const vols: Record<string, number | null> = {};
  const sectors: Record<string, string | null> = {};
  const quality: DataQualityMap = {};
  for (const id of ids) {
    prices[id] = 100;
    volumes[id] = 1_000_000;
    adv[id] = 100_000_000;
    spreads[id] = 5;
    vols[id] = 0.2;
    sectors[id] = 'Banks';
    for (const k of ['price', 'adv', 'spread', 'sector', 'vol']) quality[`${k}:${id}`] = 'VALID';
  }
  return { prices, volumes, adv, spreads_bps: spreads, volatilities: vols, sectors, correlations: {}, quality, as_of: tick, ...over };
}

function baseReq(ids: string[], over: Partial<PipelineRequest> = {}): PipelineRequest {
  return {
    portfolio_id: 'port-1',
    candidates: ids.map((id) => cand(id)),
    market: market(ids),
    current: [],
    capital: { total: 1_000_000, reserved_pct: 0, base_currency: 'INR' },
    peak_equity: 1_000_000,
    prev_equity: 1_000_000,
    actor: 'test',
    trace_id: 'trace-1',
    now: tick,
    ...over
  };
}

describe('portfolio pipeline', () => {
  beforeEach(() => { tick = 5_000_000_000_000; });

  it('builds an approved hypothetical portfolio within all caps', () => {
    const { service } = setup();
    const r = service.construct(baseReq(['A', 'B', 'C']));
    expect(['COMPLETED', 'PARTIAL']).toContain(r.flow);
    const totalW = Object.values(r.decision.exposure)[0];
    void totalW;
    expect(r.decision.exposure.gross_pct).toBeLessThanOrEqual(60);
    expect(r.decision.outcome).toBe('TRADE');
    expect(r.target_positions.length).toBeGreaterThan(0);
    expect(r.decision.risk_decisions.length).toBeGreaterThan(0);
    expect(r.decision.versions.config).toBe('portfolio-policy-v1');
  });

  it('NO_TRADE on empty candidates (success, not failure)', () => {
    const { service } = setup();
    const r = service.construct(baseReq([]));
    expect(r.flow).toBe('NO_TRADE');
    expect(r.decision.outcome).toBe('NO_TRADE');
  });

  it('RISK_BLOCKED when every candidate is rejected', () => {
    const { service } = setup();
    const m = market(['A']);
    m.quality['spread:A'] = 'QUARANTINED';
    const r = service.construct({ ...baseReq(['A']), market: m });
    expect(r.decision.outcome).toBe('RISK_BLOCKED');
    expect(r.flow).toBe('RISK_BLOCKED');
    expect(r.target_positions).toHaveLength(0);
  });

  it('risk always wins over allocator (2% cap holds)', () => {
    const { service } = setup();
    const req = baseReq(['A']) as unknown as { candidates: PortfolioCandidate[] };
    void req;
    const r = service.construct(baseReq(['A'], { allocation: 'equal' }));
    const pos = r.target_positions[0]!;
    expect(pos.weight_pct).toBeLessThanOrEqual(2.01);
  });

  it('UNKNOWN risk input blocks the candidate', () => {
    const { service } = setup();
    const m = market(['A', 'B']);
    delete m.adv['B'];
    const r = service.construct({ ...baseReq(['A', 'B']), market: m });
    expect(r.decision.rejected.some((x) => x.instrument_id === 'B')).toBe(true);
    expect(r.decision.approved['B']).toBeUndefined();
  });

  it('idempotent reruns produce identical decisions, no duplicate state', () => {
    const { store, service } = setup();
    const req = baseReq(['A', 'B']);
    const kv0 = store.knowledgeVersion();
    const r1 = service.construct(req);
    const kv1 = store.knowledgeVersion();
    const r2 = service.construct(req);
    expect(r2.decision.decision_id).toBe(r1.decision.decision_id);
    expect(r2.decision).toEqual(r1.decision);
    expect(store.knowledgeVersion()).toBe(kv1);
    expect(kv1).toBeGreaterThan(kv0);
  });

  it('scoped event invalidation drops only affected candidates', () => {
    const { service } = setup();
    const { kept, dropped } = service.invalidateCandidates(
      [cand('A'), cand('B')],
      ['instrument:A']
    );
    expect(kept.map((c) => c.instrument.instrument_id)).toEqual(['B']);
    expect(dropped.map((d) => d.candidate_id)).toEqual(['cand-A']);
  });

  it('strategy attribution chains position to evidence', () => {
    const { service } = setup();
    const r = service.construct(baseReq(['A']));
    const p = r.target_positions[0]!;
    expect(p.strategy_id).toBe('test:roc');
    expect(r.decision.evidence_refs).toBeDefined();
    expect(r.decision.versions.strategy).toContain('test:roc');
  });

  it('drawdown HALTED state blocks new risk', () => {
    const { service } = setup();
    const r = service.construct({ ...baseReq(['A']), drawdown_override: 9 });
    expect(r.decision.outcome).toBe('RISK_BLOCKED');
    expect(r.state.drawdown_state).toBe('HALTED');
  });

  it('daily-loss breach halts with RESTRICTED/HALTED states', () => {
    const { service } = setup();
    const r = service.construct({ ...baseReq(['A']), daily_pnl_override: 2 });
    expect(r.flow).toBe('RISK_BLOCKED');
  });
});

describe('service boundaries', () => {
  it('service never touches broker/execution/gateway/training', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${f.name}`;
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts')) files.push(p);
      }
    };
    walk('apps/portfolio-service/src');
    walk('packages/portfolio/src');
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/@aurix\/(broker-sim|broker-kite|execution-service|model-gateway)/);
      expect(src).not.toMatch(/\bplaceOrder\b|BrokerPort|kiteconnect/);
      expect(src).not.toMatch(/\beval\s*\(|new Function\s*\(|child_process/);
    }
  });

  it('intents are hypothetical vocabulary, never broker orders', () => {
    const { service } = setup();
    const r = service.construct(baseReq(['A']));
    const text = JSON.stringify(r.decision);
    expect(text).not.toMatch(/brokerOrderId|BrokerPort|kiteconnect/i);
  });
});
