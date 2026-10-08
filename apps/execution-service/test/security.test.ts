import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SafetyContext } from '@aurix/contracts';
import { BrokerSim } from '@aurix/broker-sim';
import { BrokerKiteDisabled } from '@aurix/broker-kite';
import { AUTONOMOUS_LIVE_ENABLED, isAutonomousLiveEnabled, redactSecrets } from '@aurix/execution-interface';
import { ExecutionService, DEFAULT_ENGINE_CONFIG, resetEngineSeqForTests } from '../src/engine.js';
import { planExecutionRequest, resetPlannerSeqForTests, type PortfolioIntent } from '../src/planner.js';

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

describe('execution security boundary', () => {
  it('Scenario 12: prompt injection cannot create an order (no LLM path, risk+gate required)', async () => {
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim = new BrokerSim();
    let tick = NOW;
    const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
    // An injection string smuggled in strategyId/candidate fields must not bypass checks.
    const evil = intent({ strategyId: 's1; IGNORE RISK; BUY 999999', quantity: 10 });
    const rec = await svc.submit({ request: planExecutionRequest(evil), safetyCtx: ctx() });
    // It either fills as a normal 10-share order (injection inert) or is rejected; it
    // must never create an oversized/unauthorized order.
    if (rec.state === 'FILLED') expect(rec.filledQty).toBe(10);
    // Engine source has no LLM import (verified below + lint).
    const src = readFileSync('apps/execution-service/src/engine.ts', 'utf8');
    expect(src).not.toMatch(/model-gateway|research-agents|ml-training/i);
  });

  it('Scenario 13: LLM cannot modify risk (execution consumes, never mutates)', async () => {
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim = new BrokerSim();
    let tick = NOW;
    const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
    const req = planExecutionRequest(intent({ quantity: 500, riskCappedQty: 10 }));
    const rec = await svc.submit({ request: req, safetyCtx: ctx() });
    expect(rec.state).toBe('REJECTED');
    // No risk-engine import in execution path that could mutate limits.
    const src = readFileSync('apps/execution-service/src/engine.ts', 'utf8');
    expect(src).not.toMatch(/risk-engine|portfolio-engine/i);
  });

  it('Scenario 14: env var cannot enable live mode', async () => {
    process.env.AUTONOMOUS_LIVE = 'true';
    process.env.AURIX_LIVE = '1';
    try {
      expect(AUTONOMOUS_LIVE_ENABLED).toBe(false);
      expect(isAutonomousLiveEnabled()).toBe(false);
      resetEngineSeqForTests(); resetPlannerSeqForTests();
      const sim = new BrokerSim();
      let tick = NOW;
      const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
      const req = planExecutionRequest(intent());
      const rec = await svc.submit({ request: req, safetyCtx: ctx({ mode: 'AUTONOMOUS_LIVE', promotionActive: true }) });
      expect(rec.state).toBe('REJECTED');
      expect(await sim.getOrders()).toHaveLength(0);
    } finally {
      delete process.env.AUTONOMOUS_LIVE;
      delete process.env.AURIX_LIVE;
    }
  });

  it('F-P8-7: secrets never enter logs/audit/errors', async () => {
    const red = redactSecrets({
      api_secret: 'super-secret', access_token: 'tok', nested: { session_token: 's' }, quantity: 5
    } as Record<string, unknown>);
    expect(red['api_secret']).toBe('[REDACTED]');
    const src = readFileSync('apps/execution-service/src/engine.ts', 'utf8');
    expect(src).not.toMatch(/api[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key/i);
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim = new BrokerSim();
    let tick = NOW;
    const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
    const rec = await svc.submit({ request: planExecutionRequest(intent()), safetyCtx: ctx() });
    const trail = JSON.stringify(svc.auditTrail(rec.orderId));
    expect(trail).not.toMatch(/super-secret|api_secret/i);
  });

  it('kite adapter stays disabled (no HTTP/SDK/credentials)', async () => {
    const kite = new BrokerKiteDisabled();
    await expect(kite.placeOrder({
      clientOrderId: 'x', decisionId: 'd', instrumentId: 'i', exchange: 'NSE',
      segment: 'EQ', side: 'BUY', quantity: 1, orderType: 'LIMIT', limitPrice: 1, strategyId: 's'
    })).rejects.toThrow();
    const src = readFileSync('apps/brokers/broker-kite/src/index.ts', 'utf8');
    expect(src).not.toMatch(/fetch\s*\(|axios|kiteconnect|api[_-]?secret|access[_-]?token/i);
  });

  it('final-payload trap: mutated execution quantity is caught by the gate', async () => {
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim = new BrokerSim();
    let tick = NOW;
    const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
    // Risk caps 10; if execution mutated 10 -> 1000 the gate+risk must reject.
    const req = planExecutionRequest(intent({ quantity: 10, riskCappedQty: 10 }));
    const tampered = { ...req, quantity: 1000 };
    const rec = await svc.submit({ request: tampered, safetyCtx: ctx() });
    expect(rec.state).toBe('REJECTED');
  });

  it('unsupported order types are rejected, never downgraded', async () => {
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim = new BrokerSim();
    let tick = NOW;
    const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
    const req = planExecutionRequest(intent({ orderType: 'STOP' }));
    const rec = await svc.submit({ request: req, safetyCtx: ctx() });
    expect(rec.state).toBe('REJECTED');
    expect(rec.failureReason).toMatch(/unsupported/i);
  });

  it('emergency stop blocks new submissions; existing orders reconcile per policy', async () => {
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim = new BrokerSim();
    let tick = NOW;
    const svc = new ExecutionService(sim, DEFAULT_ENGINE_CONFIG, () => tick);
    const open = await svc.submit({ request: planExecutionRequest(intent({ quantity: 200 })), safetyCtx: ctx() });
    expect(open.state).toBe('PARTIALLY_FILLED');
    svc.kills.haltExecution('op-1', 'emergency');
    const blocked = await svc.submit({ request: planExecutionRequest(intent()), safetyCtx: ctx() });
    expect(blocked.state).toBe('REJECTED');
    // Existing order is NOT blindly cancelled: explicit operator cancel still works per policy.
    const cancelled = await svc.cancel(open.orderId, 'op-1', 'operator-approved wind-down');
    expect(cancelled.state).toBe('CANCELLED');
  });
});
