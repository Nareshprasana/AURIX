// @aurix/broker-kite — DISABLED scaffold. Phase 1 must never reach a real broker.
import type { OrderCmd } from '@aurix/contracts';
import type { BrokerOrder, BrokerPort, BrokerPosition, Funds } from '@aurix/execution-interface';
import { Phase1DisabledError } from '@aurix/execution-interface';

export class BrokerKiteDisabled implements BrokerPort {
  readonly kind = 'kite-disabled';
  private err(): never {
    throw new Phase1DisabledError('broker-kite');
  }
  async placeOrder(_cmd: OrderCmd): Promise<BrokerOrder> {
    void _cmd;
    this.err();
  }
  async cancelOrder(_id: string): Promise<void> {
    void _id;
    this.err();
  }
  async modifyOrder(_id: string): Promise<void> {
    void _id;
    this.err();
  }
  async fetchOrder(_id: string): Promise<BrokerOrder> {
    void _id;
    this.err();
  }
  async fetchPositions(): Promise<BrokerPosition[]> {
    this.err();
  }
  async fetchFunds(): Promise<Funds> {
    this.err();
  }
}

/** Phase 1 factory: only 'sim' resolves. Anything else throws. */
export function createBroker(kind: string): BrokerPort {
  if (kind === 'sim') {
    // Lazily imported by execution-service; direct import avoided here to keep factory total.
    throw new Error("use BrokerSim directly; factory only guards: kind must be 'sim'");
  }
  throw new Phase1DisabledError(`broker-kind:${kind}`);
}
