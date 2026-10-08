// @aurix/broker-sim — ONLY executable broker in Phase 1.
import type { OrderCmd } from '@aurix/contracts';
import type { BrokerOrder, BrokerPort, BrokerPosition, Funds } from '@aurix/execution-interface';

interface SimOrder extends BrokerOrder {
  cmd: OrderCmd;
  price: number;
}

export class BrokerSim implements BrokerPort {
  readonly kind = 'sim';
  private orders = new Map<string, SimOrder>();
  private seq = 0;

  async placeOrder(cmd: OrderCmd, opts?: { lastPrice?: number }): Promise<BrokerOrder> {
    if (cmd.quantity <= 0) {
      const o: SimOrder = { brokerOrderId: `sim-${(this.seq += 1)}`, status: 'REJECTED', filledQty: 0, avgPrice: null, cmd, price: 0 };
      this.orders.set(o.brokerOrderId, o);
      return o;
    }
    const price = cmd.limitPrice ?? opts?.lastPrice ?? 100;
    // Partial-fill simulation: qty > 100 fills half, remainder open.
    const partial = cmd.quantity > 100;
    const o: SimOrder = {
      brokerOrderId: `sim-${(this.seq += 1)}`,
      status: partial ? 'PARTIAL' : 'FILLED',
      filledQty: partial ? Math.floor(cmd.quantity / 2) : cmd.quantity,
      avgPrice: price,
      cmd,
      price
    };
    this.orders.set(o.brokerOrderId, o);
    return o;
  }

  async cancelOrder(id: string): Promise<void> {
    const o = this.orders.get(id);
    if (!o) throw new Error(`unknown order ${id}`);
    if (o.status === 'FILLED') throw new Error('cannot cancel FILLED order');
    o.status = 'CANCELLED';
  }

  async modifyOrder(id: string, patch: { quantity?: number; limitPrice?: number | null }): Promise<void> {
    const o = this.orders.get(id);
    if (!o) throw new Error(`unknown order ${id}`);
    if (o.status === 'FILLED' || o.status === 'CANCELLED') throw new Error(`cannot modify ${o.status}`);
    if (patch.quantity !== undefined) o.cmd = { ...o.cmd, quantity: patch.quantity };
    if (patch.limitPrice !== undefined) o.cmd = { ...o.cmd, limitPrice: patch.limitPrice };
  }

  async fetchOrder(id: string): Promise<BrokerOrder> {
    const o = this.orders.get(id);
    if (!o) throw new Error(`unknown order ${id}`);
    return o;
  }

  async fetchPositions(): Promise<BrokerPosition[]> {
    const pos = new Map<string, BrokerPosition>();
    for (const o of this.orders.values()) {
      if (o.filledQty <= 0 || o.avgPrice == null) continue;
      const dir = o.cmd.side === 'BUY' ? 1 : -1;
      const cur = pos.get(o.cmd.instrumentId) ?? { instrumentId: o.cmd.instrumentId, qty: 0, avgPrice: 0 };
      const newQty = cur.qty + dir * o.filledQty;
      cur.avgPrice = newQty === 0 ? 0 : (Math.abs(cur.qty) * cur.avgPrice + o.filledQty * o.avgPrice) / Math.abs(newQty);
      cur.qty = newQty;
      pos.set(o.cmd.instrumentId, cur);
    }
    return [...pos.values()].filter((p) => p.qty !== 0);
  }

  async fetchFunds(): Promise<Funds> {
    return { equity: 1_000_000, cash: 1_000_000 };
  }

  /** Test helper: force-fill the remainder of a partial order. */
  fillRemainder(id: string): BrokerOrder {
    const o = this.orders.get(id);
    if (!o) throw new Error(`unknown order ${id}`);
    o.filledQty = o.cmd.quantity;
    o.status = 'FILLED';
    return o;
  }
}
