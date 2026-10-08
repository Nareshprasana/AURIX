import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { routeOrder } from '../src/index.js';
import { BrokerSim } from '@aurix/broker-sim';
import { BrokerKiteDisabled, createBroker } from '@aurix/broker-kite';
import { Phase1DisabledError } from '@aurix/execution-interface';
import type { OrderCmd, SafetyContext } from '@aurix/contracts';

const NOW = 1_700_000_000_000;
const INSTRUMENT = {
  id: 'NSE_EQ_RELIANCE', exchange: 'NSE', market: 'equity', segment: 'EQ',
  symbol: 'RELIANCE', isin: 'INE002A01018', lot_size: 1, tick_size: 0.05, contract: null
};

function cmd(): OrderCmd {
  return {
    clientOrderId: 'safe-1', decisionId: 'd1', instrumentId: 'NSE_EQ_RELIANCE',
    exchange: 'NSE', segment: 'EQ', side: 'BUY', quantity: 10,
    orderType: 'LIMIT', limitPrice: 100, strategyId: 's1'
  };
}

function ctx(over: Partial<SafetyContext> = {}): SafetyContext {
  return {
    instrument: INSTRUMENT, eligibility: 'LEGAL', marketStatus: 'OPEN',
    riskVerdict: { allow: true, cappedQty: 10, reasons: ['ok'], policyVersion: 'v1' },
    mode: 'PAPER', promotionActive: false, strategyAuthorized: true, riskHalted: false,
    nowTs: NOW, decisionTs: NOW - 1000, marketDataTs: NOW - 1000,
    decisionTtlS: 60, marketDataStalenessS: 120,
    seenIdempotencyKeys: new Set<string>(), lastPrice: 100, brokerMaxQty: 1000, ...over
  };
}

describe('Phase 1 safety proofs', () => {
  it('LLM gateway cannot call broker directly (no broker import path)', () => {
    const src = readFileSync('apps/model-gateway/src/index.ts', 'utf8');
    expect(src).not.toMatch(/broker-sim|broker-kite|BrokerPort|placeOrder/i);
  });

  it('LLM output cannot bypass risk: execution requires a risk verdict', async () => {
    await expect(routeOrder({ cmd: cmd(), risk: null, safetyCtx: ctx(), broker: new BrokerSim() })).rejects.toThrow(/missing risk verdict/);
  });

  it('risk REJECT never reaches execution (sim sees zero orders)', async () => {
    const sim = new BrokerSim();
    await expect(
      routeOrder({
        cmd: cmd(),
        risk: { allow: false, cappedQty: 0, reasons: ['oversized'], policyVersion: 'v1' },
        safetyCtx: ctx(),
        broker: sim
      })
    ).rejects.toThrow(/risk verdict REJECT/);
    expect(await sim.fetchPositions()).toHaveLength(0);
  });

  it('Phase 1 cannot reach a real broker', async () => {
    const kite = new BrokerKiteDisabled();
    await expect(kite.placeOrder(cmd())).rejects.toThrow(Phase1DisabledError);
    expect(() => createBroker('kite')).toThrow(Phase1DisabledError);
    await expect(routeOrder({ cmd: cmd(), risk: { allow: true, cappedQty: 10, reasons: ['ok'], policyVersion: 'v1' }, safetyCtx: ctx(), broker: kite as never })).rejects.toThrow();
  });

  it('UNKNOWN eligibility cannot trade (risk + gate + execution all block)', async () => {
    const sim = new BrokerSim();
    const bad = ctx({ eligibility: 'UNKNOWN' });
    await expect(
      routeOrder({
        cmd: cmd(),
        risk: { allow: false, cappedQty: 0, reasons: ['eligibility not LEGAL'], policyVersion: 'v1' },
        safetyCtx: bad,
        broker: sim
      })
    ).rejects.toThrow();
    expect(await sim.fetchPositions()).toHaveLength(0);
  });

  it('live mode is rejected by execution even with ACTIVE promotion claim + sim broker', async () => {
    const sim = new BrokerSim();
    await expect(
      routeOrder({
        cmd: cmd(),
        risk: { allow: true, cappedQty: 10, reasons: ['ok'], policyVersion: 'v1' },
        safetyCtx: ctx({ mode: 'AUTONOMOUS_LIVE', promotionActive: true }),
        broker: sim
      })
    ).rejects.toThrow(/live mode/);
    expect(await sim.fetchPositions()).toHaveLength(0);
  });
});
