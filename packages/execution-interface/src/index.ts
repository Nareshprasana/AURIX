// @aurix/execution-interface — BrokerPort + order lifecycle types.
import type { OrderCmd, OrderStatus } from '@aurix/contracts';

export type { OrderCmd, OrderStatus };

export interface BrokerOrder {
  brokerOrderId: string;
  status: OrderStatus;
  filledQty: number;
  avgPrice: number | null;
}

export interface BrokerPosition {
  instrumentId: string;
  qty: number;
  avgPrice: number;
}

export interface Funds {
  equity: number;
  cash: number;
}

export class Phase1DisabledError extends Error {
  constructor(adapter: string) {
    super(`${adapter} is disabled in Phase 1: no real broker reachable`);
    this.name = 'Phase1DisabledError';
  }
}

export interface BrokerPort {
  readonly kind: string;
  placeOrder(cmd: OrderCmd, opts?: { lastPrice?: number }): Promise<BrokerOrder>;
  cancelOrder(id: string): Promise<void>;
  modifyOrder(id: string, patch: { quantity?: number; limitPrice?: number | null }): Promise<void>;
  fetchOrder(id: string): Promise<BrokerOrder>;
  fetchPositions(): Promise<BrokerPosition[]>;
  fetchFunds(): Promise<Funds>;
}
