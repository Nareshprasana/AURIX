import { describe, expect, it } from 'vitest';
import type { SafetyContext } from '@aurix/contracts';
import { BrokerSim } from '@aurix/broker-sim';
import { ExecutionService, DEFAULT_ENGINE_CONFIG } from '../src/engine.js';
import { planExecutionRequest, type PortfolioIntent } from '../src/planner.js';
import { resetEngineSeqForTests } from '../src/engine.js';
import { resetPlannerSeqForTests } from '../src/planner.js';

const NOW = 1_700_000_000_000;
const INSTRUMENT = {
  id: 'NSE_EQ_RELIANCE', exchange: 'NSE', market: 'equity', segment: 'EQ',
  symbol: 'RELIANCE', isin: 'INE002A01018', lot_size: 1, tick_size: 0.05, contract: null
};

function ctx(over: Partial<SafetyContext> = {}): SafetyContext {
  return {
    instrument: INSTRUMENT, eligibility: 'LEGAL', marketStatus: 'OPEN',
    riskVerdict: { allow: true, cappedQty: 1000, reasons: ['ok'], policyVersion: 'v1' },
    mode: 'PAPER', promotionActive: false, strategyAuthorized: true, riskHalted: false,
    nowTs: NOW, decisionTs: NOW - 1000, marketDataTs: NOW - 1000,
    decisionTtlS: 60, marketDataStalenessS: 120,
    seenIdempotencyKeys: new Set<string>(), lastPrice: 100, brokerMaxQty: 10000, ...over
  };
}

function intent(over: Partial<PortfolioIntent> = {}): PortfolioIntent {
  return {
    portfolioDecisionId: `pdec-${Math.random().toString(36).slice(2)}`,
    portfolioVersion: 1, candidateId: 'cand-1', positionId: null, desiredAction: 'BUY',
    instrumentId: 'NSE_EQ_RELIANCE', exchange: 'NSE', segment: 'EQ', side: 'BUY',
    quantity: 10, orderType: 'LIMIT', limitPrice: 100, triggerPrice: null, timeInForce: 'DAY',
    strategyId: 's1', strategyVersion: 1, riskDecisionId: 'risk-1', riskAllow: true,
    riskCappedQty: 1000, riskPolicyVersion: 'v1', traceId: `t-${Math.random().toString(36).slice(2)}`,
    configVersion: 'exec-policy-v1', requestedAt: NOW, executionMode: 'SIMULATION', ...over
  };
}

function serviceWithSim() {
  resetEngineSeqForTests();
  resetPlannerSeqForTests();
  const sim = new BrokerSim();
  let tick = NOW;
  const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
  return { sim, svc, advance: (ms: number) => { tick += ms; } };
}

describe('execution lifecycle (§57 loop)', () => {
  it('Scenario 1: valid order -> filled with full traceability', async () => {
    const { svc } = serviceWithSim();
    const req = planExecutionRequest(intent());
    const rec = await svc.submit({ request: req, safetyCtx: ctx() });
    expect(rec.state).toBe('FILLED');
    expect(rec.filledQty).toBe(10);
    expect(rec.remainingQty).toBe(0);
    expect(rec.brokerOrderId).toMatch(/^sim-/);
    // Traceability: strategy -> portfolio -> risk -> request -> order -> broker -> fill.
    expect(rec.intent.strategyId).toBe('s1');
    expect(rec.intent.portfolioDecisionId).toBe(req.portfolioDecisionId);
    expect(rec.intent.riskDecisionId).toBe('risk-1');
    expect(rec.fills).toHaveLength(1);
    expect(rec.history.length).toBeGreaterThan(3);
    const trail = svc.auditTrail(rec.orderId);
    expect(trail.some((a) => a.kind === 'safety-gate')).toBe(true);
    expect(trail.some((a) => a.kind === 'submit')).toBe(true);
  });

  it('Scenario 2: invalid quantity -> blocked', async () => {
    const { svc } = serviceWithSim();
    const req = planExecutionRequest(intent({ quantity: 0 }));
    const rec = await svc.submit({ request: req, safetyCtx: ctx() });
    expect(['REJECTED', 'BROKER_REJECTED']).toContain(rec.state);
  });

  it('Scenario 3: stale price -> blocked', async () => {
    const { svc } = serviceWithSim();
    const req = planExecutionRequest(intent({ quantity: 10, limitPrice: 100 }));
    const stale = ctx({ lastPrice: 100, marketDataTs: NOW - 500_000 });
    const rec = await svc.submit({ request: req, safetyCtx: stale });
    expect(rec.state).toBe('REJECTED');
  });

  it('Scenario 4: risk rejection -> blocked (execution never overrides risk)', async () => {
    const { svc, sim } = serviceWithSim();
    const req = planExecutionRequest(intent({ riskAllow: false, riskCappedQty: 0 }));
    const rec = await svc.submit({
      request: req,
      safetyCtx: ctx({ riskVerdict: { allow: false, cappedQty: 0, reasons: ['oversized'], policyVersion: 'v1' } })
    });
    expect(rec.state).toBe('REJECTED');
    expect(await sim.getPositions()).toHaveLength(0);
  });

  it('Scenario 5: safety gate rejection -> blocked', async () => {
    const { svc } = serviceWithSim();
    const req = planExecutionRequest(intent({ quantity: 10 }));
    // Gate rejects: quantity exceeds broker max.
    const rec = await svc.submit({ request: req, safetyCtx: ctx({ brokerMaxQty: 5 }) });
    expect(rec.state).toBe('REJECTED');
  });

  it('Scenario 6: duplicate execution request -> one semantic order', async () => {
    const { svc, sim } = serviceWithSim();
    const base = intent();
    const a = planExecutionRequest(base);
    const r1 = await svc.submit({ request: a, safetyCtx: ctx() });
    // Same idempotency key replayed.
    const r2 = await svc.submit({ request: { ...a }, safetyCtx: ctx() });
    expect(r2.orderId).toBe(r1.orderId);
    expect(await sim.getOrders()).toHaveLength(1);
  });

  it('Scenario 7: submission timeout -> UNKNOWN -> reconciliation', async () => {
    const { svc, sim } = serviceWithSim();
    // Timeout injected at submission (funds/positions succeed, placeOrder times out).
    const orig = sim.placeOrder.bind(sim);
    let once = true;
    sim.placeOrder = (async (c: never, o?: never) => {
      if (once) {
        once = false;
        const { BrokerError: BE } = await import('@aurix/execution-interface');
        throw new BE('TIMEOUT', 'simulated submission timeout');
      }
      return orig(c as never, o as never);
    }) as typeof sim.placeOrder;
    const req = planExecutionRequest(intent());
    const rec = await svc.submit({ request: req, safetyCtx: ctx() });
    expect(rec.state).toBe('UNKNOWN');
    expect(rec.failureClass).toBe('RECONCILE_FIRST');
    // Must NOT have blindly resubmitted: zero broker orders created on timeout path.
    // Reconcile: broker has nothing (timeout before creation) -> deferred, still safe.
    const report = await svc.reconcile(rec.orderId);
    expect(['DEFERRED_UNKNOWN', 'ADOPTED_BROKER', 'NO_DIFF']).toContain(report.result);
    // No duplicate: exactly zero or one broker order, never two from one request.
    expect((await sim.getOrders()).length).toBeLessThanOrEqual(1);
  });

  it('Scenario 8: partial fill -> correct remaining quantity', async () => {
    const { svc } = serviceWithSim();
    const req = planExecutionRequest(intent({ quantity: 200 }));
    const rec = await svc.submit({ request: req, safetyCtx: ctx() });
    expect(rec.state).toBe('PARTIALLY_FILLED');
    expect(rec.filledQty).toBe(100);
    expect(rec.remainingQty).toBe(100);
    expect(rec.state).not.toBe('FILLED');
  });

  it('Scenario 9: broker outage -> no new risk', async () => {
    const { svc } = serviceWithSim();
    const { sim } = { sim: (svc as unknown as { broker: BrokerSim }).broker } as never as { sim: BrokerSim };
    void sim;
    // Use direct sim outage via fresh service.
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim2 = new BrokerSim();
    sim2.setOutage(true);
    let tick = NOW;
    const svc2 = new ExecutionService(sim2, DEFAULT_ENGINE_CONFIG, () => tick);
    const req = planExecutionRequest(intent());
    const rec = await svc2.submit({ request: req, safetyCtx: ctx() });
    // Outage during funds/position check blocks new risk (never fabricates broker state).
    expect(rec.state).toBe('REJECTED');
    expect(rec.failureReason).toMatch(/outage|stale|reconcile|OUTAGE/i);
  });

  it('Scenario 15: kill switch active -> new orders blocked', async () => {
    const { svc } = serviceWithSim();
    svc.kills.activateGlobal('op-1', 'test halt');
    const req = planExecutionRequest(intent());
    const rec = await svc.submit({ request: req, safetyCtx: ctx() });
    expect(rec.state).toBe('REJECTED');
    expect(rec.failureReason).toMatch(/kill switch|halt/i);
  });

  it('Scenario 16: unknown instrument eligibility -> blocked', async () => {
    const { svc } = serviceWithSim();
    const req = planExecutionRequest(intent());
    const rec = await svc.submit({ request: req, safetyCtx: ctx({ eligibility: 'UNKNOWN' }) });
    expect(rec.state).toBe('REJECTED');
  });

  it('Scenario 18: malformed broker response -> safe failure (UNKNOWN, never trusted)', async () => {
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim = new BrokerSim();
    // Wrap placeOrder to return malformed payload once.
    const orig = sim.placeOrder.bind(sim);
    let once = true;
    sim.placeOrder = (async (c: never, o?: never) => {
      if (once) { once = false; return { brokerOrderId: '', status: 'WEIRD', filledQty: -5, avgPrice: NaN } as never; }
      return orig(c as never, o as never);
    }) as typeof sim.placeOrder;
    let tick = NOW;
    const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
    const req = planExecutionRequest(intent());
    const rec = await svc.submit({ request: req, safetyCtx: ctx() });
    expect(rec.state).toBe('UNKNOWN');
  });
});
