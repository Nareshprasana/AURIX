import { describe, expect, it } from 'vitest';
import { BrokerSim } from '../src/index.js';
import type { OrderCmd } from '@aurix/contracts';

function cmd(over: Partial<OrderCmd> = {}): OrderCmd {
  return {
    clientOrderId: `c-${Math.random().toString(36).slice(2)}`,
    decisionId: 'd1',
    instrumentId: 'NSE_EQ_RELIANCE',
    exchange: 'NSE',
    segment: 'EQ',
    side: 'BUY',
    quantity: 10,
    orderType: 'LIMIT',
    limitPrice: 100,
    strategyId: 's1',
    ...over
  };
}

describe('broker-sim', () => {
  it('creates an order', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd());
    expect(o.brokerOrderId).toMatch(/^sim-/);
  });

  it('fills a normal order', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd({ quantity: 10 }));
    expect(o.status).toBe('FILLED');
    expect(o.filledQty).toBe(10);
  });

  it('partially fills large orders and can complete', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd({ quantity: 200 }));
    expect(o.status).toBe('PARTIAL');
    expect(o.filledQty).toBe(100);
    const done = sim.fillRemainder(o.brokerOrderId);
    expect(done.status).toBe('FILLED');
  });

  it('rejects invalid quantity', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd({ quantity: -1 }));
    expect(o.status).toBe('REJECTED');
  });

  it('cancels an open partial order', async () => {
    const sim = new BrokerSim();
    const o = await sim.placeOrder(cmd({ quantity: 200 }));
    await sim.cancelOrder(o.brokerOrderId);
    expect((await sim.fetchOrder(o.brokerOrderId)).status).toBe('CANCELLED');
  });

  it('reconciles positions from fills (broker authoritative)', async () => {
    const sim = new BrokerSim();
    await sim.placeOrder(cmd({ quantity: 10, side: 'BUY' }));
    const positions = await sim.fetchPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.qty).toBe(10);
    expect((await sim.fetchFunds()).equity).toBeGreaterThan(0);
  });
});
