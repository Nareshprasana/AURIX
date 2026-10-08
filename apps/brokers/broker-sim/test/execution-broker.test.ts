import { describe, expect, it } from 'vitest';
import { BrokerSim } from '../src/index.js';
import { BrokerError } from '@aurix/execution-interface';
import type { OrderCmd } from '@aurix/contracts';

function cmd(over: Partial<OrderCmd> = {}): OrderCmd {
  return {
    clientOrderId: `c-${over.clientOrderId ?? Math.random().toString(36).slice(2)}`,
    decisionId: 'd1', instrumentId: 'NSE_EQ_RELIANCE', exchange: 'NSE', segment: 'EQ',
    side: 'BUY', quantity: 10, orderType: 'LIMIT', limitPrice: 100, strategyId: 's1', ...over
  };
}

describe('broker-sim full interface', () => {
  it('authenticates without credentials', async () => {
    const sim = new BrokerSim();
    const a = await sim.authenticate();
    expect(a.ok).toBe(true);
  });
  it('serves account/positions/orders/instrument/quote/margin', async () => {
    const sim = new BrokerSim();
    expect((await sim.getAccountState()).equity).toBeGreaterThan(0);
    expect(await sim.getPositions()).toHaveLength(0);
    expect(await sim.getOrders()).toHaveLength(0);
    expect((await sim.getInstrument('NSE_EQ_RELIANCE')).lotSize).toBe(1);
    expect((await sim.getQuote('NSE_EQ_RELIANCE')).lastPrice).toBeGreaterThan(0);
    expect((await sim.getMargin(cmd())).sufficient).toBe(true);
  });
  it('accepted order fills', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd({ quantity: 10 }));
    expect(o.status).toBe('FILLED');
  });
  it('rejected order via fault', async () => {
    const sim = new BrokerSim();
    sim.setFaults({ rejectNext: 'simulated reject' });
    const o = await sim.placeOrder(cmd({ quantity: 10 }));
    expect(o.status).toBe('REJECTED');
  });
  it('partial fill then remainder', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd({ quantity: 200 }));
    expect(o.status).toBe('PARTIAL');
    const done = sim.fillRemainder(o.brokerOrderId);
    expect(done.status).toBe('FILLED');
  });
  it('full fill path', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd({ quantity: 10 }));
    expect(o.filledQty).toBe(10);
    const fetched = await sim.getOrder(o.brokerOrderId);
    expect(fetched.status).toBe('FILLED');
  });
  it('cancel works on partial', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd({ quantity: 200 }));
    await sim.cancelOrder(o.brokerOrderId);
    expect((await sim.getOrder(o.brokerOrderId)).status).toBe('CANCELLED');
  });
  it('timeout fault throws TIMEOUT', async () => {
    const sim = new BrokerSim();
    sim.setFaults({ timeoutNext: 1 });
    await expect(sim.placeOrder(cmd())).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('duplicate clientOrderId returns same broker order (idempotent)', async () => {
    const sim = new BrokerSim();
    const c = cmd({ clientOrderId: 'dup-1', quantity: 10 });
    const a = await sim.placeOrder(c);
    const b = await sim.placeOrder(c);
    expect(b.brokerOrderId).toBe(a.brokerOrderId);
    expect(await sim.getOrders()).toHaveLength(1);
  });
  it('malformed fault surfaces as MALFORMED_RESPONSE', async () => {
    const sim = new BrokerSim();
    sim.setFaults({ malformedNext: 1 });
    await expect(sim.getOrder('anything')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
  it('outage blocks with OUTAGE', async () => {
    const sim = new BrokerSim();
    sim.setOutage(true);
    await expect(sim.placeOrder(cmd())).rejects.toMatchObject({ code: 'OUTAGE' });
    sim.setOutage(false);
    const o = await sim.placeOrder(cmd());
    expect(o.status).toBe('FILLED');
  });
  it('rate limit fault surfaces as RATE_LIMIT', async () => {
    const sim = new BrokerSim();
    sim.setFaults({ rateLimitNext: 1 });
    await expect(sim.getPositions()).rejects.toBeInstanceOf(BrokerError);
  });
});
