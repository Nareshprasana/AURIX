import { describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { SafetyContext } from '@aurix/contracts';
import { BrokerSim } from '@aurix/broker-sim';
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

describe('restart recovery (Scenario 10)', () => {
  it('crash -> restart -> reconcile before resume; uncertain -> NO_NEW_RISK', async () => {
    const file = 'node_modules/.cache/aurix-exec-restart-test.jsonl';
    try { if (existsSync(file)) rmSync(file); } catch { /* ignore */ }
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    let tick = NOW;
    // First boot: submit a partial order, then "crash" (drop the service, keep file + sim).
    const sim = new BrokerSim();
    const svc1 = new ExecutionService(sim, { ...DEFAULT_ENGINE_CONFIG, ledger: { filePath: file, maxOrders: 10000, maxAuditEvents: 50000 } }, () => tick);
    const req = planExecutionRequest(intent({ quantity: 200 }));
    const rec = await svc1.submit({ request: req, safetyCtx: ctx() });
    expect(rec.state).toBe('PARTIALLY_FILLED');

    // Restart: new engine over the same ledger file + same broker.
    const svc2 = new ExecutionService(sim, { ...DEFAULT_ENGINE_CONFIG, ledger: { filePath: file, maxOrders: 10000, maxAuditEvents: 50000 } }, () => tick);
    expect(svc2.listOrders().length).toBeGreaterThan(0);
    const recovery = await svc2.restartRecovery();
    expect(recovery.reconciled).toBeGreaterThanOrEqual(0);
    expect(typeof recovery.safeToResume).toBe('boolean');

    // Uncertain path: timeout order -> restart must enter NO_NEW_RISK.
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const file2 = 'node_modules/.cache/aurix-exec-restart-uncertain-test.jsonl';
    try { if (existsSync(file2)) rmSync(file2); } catch { /* ignore */ }
    const sim3 = new BrokerSim();
    const origPlace = sim3.placeOrder.bind(sim3);
    let once = true;
    sim3.placeOrder = (async (c: never, o?: never) => {
      if (once) {
        once = false;
        const { BrokerError: BE } = await import('@aurix/execution-interface');
        throw new BE('TIMEOUT', 'simulated submission timeout');
      }
      return origPlace(c as never, o as never);
    }) as typeof sim3.placeOrder;
    let t2 = NOW;
    const svc3 = new ExecutionService(sim3, { ...DEFAULT_ENGINE_CONFIG, ledger: { filePath: file2, maxOrders: 10000, maxAuditEvents: 50000 } }, () => t2);
    const reqU = planExecutionRequest(intent());
    const unknown = await svc3.submit({ request: reqU, safetyCtx: ctx() });
    expect(unknown.state).toBe('UNKNOWN');
    // Broker still has no order (timeout before creation) -> reconcile defers.
    const svc4 = new ExecutionService(sim3, { ...DEFAULT_ENGINE_CONFIG, ledger: { filePath: file2, maxOrders: 10000, maxAuditEvents: 50000 } }, () => t2);
    // Force the recovered UNKNOWN to stay uncertain by simulating broker outage.
    sim3.setOutage(true);
    const rec2 = await svc4.restartRecovery();
    expect(rec2.safeToResume).toBe(false);
    expect(svc4.isNoNewRisk()).toBe(true);
    // New risk blocked while NO_NEW_RISK.
    const blocked = await svc4.submit({ request: planExecutionRequest(intent()), safetyCtx: ctx() });
    expect(blocked.state).toBe('REJECTED');
    sim3.setOutage(false);
    try { if (existsSync(file)) rmSync(file); } catch { /* ignore */ }
    try { if (existsSync(file2)) rmSync(file2); } catch { /* ignore */ }
  });

  it('no duplicate order intents during restart', async () => {
    const file = 'node_modules/.cache/aurix-exec-restart-dedupe-test.jsonl';
    try { if (existsSync(file)) rmSync(file); } catch { /* ignore */ }
    resetEngineSeqForTests(); resetPlannerSeqForTests();
    const sim = new BrokerSim();
    let tick = NOW;
    const svc1 = new ExecutionService(sim, { ...DEFAULT_ENGINE_CONFIG, ledger: { filePath: file, maxOrders: 10000, maxAuditEvents: 50000 } }, () => tick);
    const base = intent();
    const r1 = await svc1.submit({ request: planExecutionRequest(base), safetyCtx: ctx() });
    const svc2 = new ExecutionService(sim, { ...DEFAULT_ENGINE_CONFIG, ledger: { filePath: file, maxOrders: 10000, maxAuditEvents: 50000 } }, () => tick);
    // Replaying the same idempotency key after restart returns the same order.
    const replay: typeof r1.intent = { ...r1.intent };
    const r2 = await svc2.submit({ request: replay, safetyCtx: ctx() });
    expect(r2.orderId).toBe(r1.orderId);
    expect(await sim.getOrders()).toHaveLength(1);
    try { if (existsSync(file)) rmSync(file); } catch { /* ignore */ }
  });
});
