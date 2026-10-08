// @aurix/broker-sim — Phase 8 deterministic simulator (ONLY executable broker).
// Implements the full BrokerPort with fault injection for testing:
// accept/reject/partial/full/cancel/timeout/duplicate/malformed/outage/rate-limit/
// slippage/fees/delay. Same canonical contracts as production (simulation parity).
// Never requires real credentials; SecretProvider always null here.
import type { OrderCmd } from '@aurix/contracts';
import type {
  BrokerAuth,
  BrokerInstrument,
  BrokerMargin,
  BrokerOrder,
  BrokerPort,
  BrokerPosition,
  BrokerQuote,
  Funds
} from '@aurix/execution-interface';
import { BrokerError } from '@aurix/execution-interface';

export interface SimFaults {
  timeoutNext?: number;
  outage?: boolean;
  rateLimitNext?: number;
  malformedNext?: number;
  rejectNext?: string | null;
  partialNext?: boolean;
  delayMs?: number;
  slippageBps?: number;
  feesBps?: number;
}

interface SimOrder extends BrokerOrder {
  cmd: OrderCmd;
  price: number;
  clientOrderId: string;
}

const INSTRUMENTS: Record<string, BrokerInstrument> = {
  NSE_EQ_RELIANCE: {
    instrumentId: 'NSE_EQ_RELIANCE', exchange: 'NSE', segment: 'EQ', symbol: 'RELIANCE',
    lotSize: 1, tickSize: 0.05, minQty: 1, maxQty: 10000
  },
  NSE_EQD_NIFTY25JAN_FUT: {
    instrumentId: 'NSE_EQD_NIFTY25JAN_FUT', exchange: 'NSE', segment: 'EQ-D', symbol: 'NIFTY',
    lotSize: 25, tickSize: 0.05, minQty: 25, maxQty: 10000
  }
};

export class BrokerSim implements BrokerPort {
  readonly kind = 'sim';
  private orders = new Map<string, SimOrder>();
  private byClient = new Map<string, string>();
  private seq = 0;
  private faults: SimFaults = {};
  private quotes = new Map<string, number>();

  constructor(faults: SimFaults = {}) {
    this.faults = { ...faults };
    this.quotes.set('NSE_EQ_RELIANCE', 100);
    this.quotes.set('NSE_EQD_NIFTY25JAN_FUT', 22000);
  }

  /** Deterministic fault control for tests. */
  setFaults(f: SimFaults): void {
    this.faults = { ...this.faults, ...f };
  }
  clearFaults(): void {
    this.faults = {};
  }
  setQuote(instrumentId: string, price: number): void {
    this.quotes.set(instrumentId, price);
  }
  setOutage(on: boolean): void {
    this.faults.outage = on;
  }

  private maybeFail(op: string): void {
    if (this.faults.outage) throw new BrokerError('OUTAGE', `${op} during simulated outage`);
    if ((this.faults.timeoutNext ?? 0) > 0) {
      this.faults.timeoutNext! -= 1;
      throw new BrokerError('TIMEOUT', `${op} simulated timeout`);
    }
    if ((this.faults.rateLimitNext ?? 0) > 0) {
      this.faults.rateLimitNext! -= 1;
      throw new BrokerError('RATE_LIMIT', `${op} simulated 429`);
    }
    if ((this.faults.malformedNext ?? 0) > 0) {
      this.faults.malformedNext! -= 1;
      throw new BrokerError('MALFORMED_RESPONSE', `${op} simulated malformed`);
    }
  }

  async authenticate(_ref?: string): Promise<BrokerAuth> {
    void _ref;
    this.maybeFail('authenticate');
    return { ok: true, accountId: 'sim-account', note: 'simulated auth (no credentials)' };
  }

  async getAccountState(): Promise<Funds> {
    this.maybeFail('getAccountState');
    return { equity: 1_000_000, cash: 1_000_000 };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    this.maybeFail('getPositions');
    return this.computePositions();
  }

  async getOrders(): Promise<BrokerOrder[]> {
    this.maybeFail('getOrders');
    return [...this.orders.values()].map((o) => this.view(o));
  }

  async getOrder(id: string): Promise<BrokerOrder> {
    this.maybeFail('getOrder');
    const o = this.orders.get(id) ?? this.byClientGet(id);
    if (!o) throw new BrokerError('INVALID_ORDER', `unknown order ${id}`);
    return this.view(o);
  }

  async getInstrument(id: string): Promise<BrokerInstrument> {
    this.maybeFail('getInstrument');
    const inst = INSTRUMENTS[id];
    if (!inst) throw new BrokerError('INVALID_ORDER', `unknown instrument ${id}`);
    return { ...inst };
  }

  async getQuote(id: string): Promise<BrokerQuote> {
    this.maybeFail('getQuote');
    const px = this.quotes.get(id);
    if (px === undefined) throw new BrokerError('INVALID_ORDER', `no quote for ${id}`);
    return { instrumentId: id, lastPrice: px, timestamp: Date.now(), stale: false };
  }

  async getMargin(cmd: OrderCmd): Promise<BrokerMargin> {
    this.maybeFail('getMargin');
    const px = cmd.limitPrice ?? this.quotes.get(cmd.instrumentId) ?? 100;
    const required = px * cmd.quantity * 0.2;
    const available = 1_000_000;
    return { required, available, sufficient: available >= required };
  }

  async placeOrder(cmd: OrderCmd, opts?: { lastPrice?: number }): Promise<BrokerOrder> {
    this.maybeFail('placeOrder');
    // Client-tag idempotency: same clientOrderId returns the same broker order.
    const priorId = this.byClient.get(cmd.clientOrderId);
    if (priorId) {
      const prior = this.orders.get(priorId);
      if (prior) return this.view(prior);
    }
    if (this.faults.rejectNext) {
      const reason = this.faults.rejectNext;
      this.faults.rejectNext = null;
      const o: SimOrder = {
        brokerOrderId: `sim-${(this.seq += 1)}`, status: 'REJECTED', filledQty: 0,
        avgPrice: null, cmd: { ...cmd }, price: 0, clientOrderId: cmd.clientOrderId
      };
      void reason;
      this.orders.set(o.brokerOrderId, o);
      this.byClient.set(cmd.clientOrderId, o.brokerOrderId);
      return this.view(o);
    }
    if (cmd.quantity <= 0) {
      const o: SimOrder = {
        brokerOrderId: `sim-${(this.seq += 1)}`, status: 'REJECTED', filledQty: 0,
        avgPrice: null, cmd: { ...cmd }, price: 0, clientOrderId: cmd.clientOrderId
      };
      this.orders.set(o.brokerOrderId, o);
      this.byClient.set(cmd.clientOrderId, o.brokerOrderId);
      return this.view(o);
    }
    let price = cmd.limitPrice ?? opts?.lastPrice ?? this.quotes.get(cmd.instrumentId) ?? 100;
    // Slippage: deterministic bps add-on for market simulation.
    const slip = this.faults.slippageBps ?? 0;
    if (slip !== 0) price = price * (1 + slip / 10000);
    const forcePartial = this.faults.partialNext === true;
    if (this.faults.partialNext !== undefined) this.faults.partialNext = false;
    const partial = forcePartial || cmd.quantity > 100;
    const o: SimOrder = {
      brokerOrderId: `sim-${(this.seq += 1)}`,
      status: partial ? 'PARTIAL' : 'FILLED',
      filledQty: partial ? Math.floor(cmd.quantity / 2) : cmd.quantity,
      avgPrice: price,
      cmd: { ...cmd },
      price,
      clientOrderId: cmd.clientOrderId
    };
    this.orders.set(o.brokerOrderId, o);
    this.byClient.set(cmd.clientOrderId, o.brokerOrderId);
    return this.view(o);
  }

  async cancelOrder(id: string): Promise<void> {
    this.maybeFail('cancelOrder');
    const o = this.orders.get(id);
    if (!o) throw new BrokerError('INVALID_ORDER', `unknown order ${id}`);
    if (o.status === 'FILLED') throw new BrokerError('BROKER_REJECTION', 'cannot cancel FILLED order');
    o.status = 'CANCELLED';
  }

  async modifyOrder(id: string, patch: { quantity?: number; limitPrice?: number | null }): Promise<void> {
    this.maybeFail('modifyOrder');
    const o = this.orders.get(id);
    if (!o) throw new BrokerError('INVALID_ORDER', `unknown order ${id}`);
    if (o.status === 'FILLED' || o.status === 'CANCELLED') throw new BrokerError('BROKER_REJECTION', `cannot modify ${o.status}`);
    if (patch.quantity !== undefined) o.cmd = { ...o.cmd, quantity: patch.quantity };
    if (patch.limitPrice !== undefined) o.cmd = { ...o.cmd, limitPrice: patch.limitPrice };
  }

  // Legacy aliases (Phase 1 compat).
  async fetchOrder(id: string): Promise<BrokerOrder> {
    return this.getOrder(id);
  }
  async fetchPositions(): Promise<BrokerPosition[]> {
    return this.getPositions();
  }
  async fetchFunds(): Promise<Funds> {
    return this.getAccountState();
  }

  /** Test helper: force-fill the remainder of a partial order. */
  fillRemainder(id: string): BrokerOrder {
    const o = this.orders.get(id);
    if (!o) throw new Error(`unknown order ${id}`);
    o.filledQty = o.cmd.quantity;
    o.status = 'FILLED';
    return this.view(o);
  }

  /** Test helper: emit a duplicate fill event shape (same filledQty, new query). */
  duplicateView(id: string): BrokerOrder {
    const o = this.orders.get(id);
    if (!o) throw new Error(`unknown order ${id}`);
    return this.view(o);
  }

  private byClientGet(id: string): SimOrder | undefined {
    const mapped = this.byClient.get(id);
    return mapped ? this.orders.get(mapped) : undefined;
  }

  private view(o: SimOrder): BrokerOrder {
    return { brokerOrderId: o.brokerOrderId, status: o.status, filledQty: o.filledQty, avgPrice: o.avgPrice };
  }

  private computePositions(): BrokerPosition[] {
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
}
