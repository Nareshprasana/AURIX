// @aurix/broker-kite — Phase 8 DISABLED scaffold.
// Conforms to the extended BrokerPort; every method throws (no HTTP, no SDK,
// no credentials, no network). Activation requires the full checklist:
// persisted promotion + explicit operator action + audit record + risk config +
// broker auth + health checks + reconciliation readiness + kill-switch readiness.
// None of these are present in Phase 8, so real submission stays unreachable.
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
import { Phase1DisabledError } from '@aurix/execution-interface';

export const KITE_ACTIVATION_CHECKLIST: readonly string[] = [
  'persisted promotion (ACTIVE)',
  'explicit operator enablement',
  'audit record of activation',
  'risk configuration bound',
  'broker authentication via secure secret store',
  'health checks passing',
  'reconciliation readiness proven',
  'kill-switch readiness proven'
] as const;

export class BrokerKiteDisabled implements BrokerPort {
  readonly kind = 'kite-disabled';
  private err(): never {
    throw new Phase1DisabledError('broker-kite');
  }
  async authenticate(_ref?: string): Promise<BrokerAuth> {
    void _ref;
    this.err();
  }
  async getAccountState(): Promise<Funds> {
    this.err();
  }
  async getPositions(): Promise<BrokerPosition[]> {
    this.err();
  }
  async getOrders(): Promise<BrokerOrder[]> {
    this.err();
  }
  async getOrder(_id: string): Promise<BrokerOrder> {
    void _id;
    this.err();
  }
  async getInstrument(_id: string): Promise<BrokerInstrument> {
    void _id;
    this.err();
  }
  async getQuote(_id: string): Promise<BrokerQuote> {
    void _id;
    this.err();
  }
  async getMargin(_cmd: OrderCmd): Promise<BrokerMargin> {
    void _cmd;
    this.err();
  }
  async placeOrder(_cmd: OrderCmd): Promise<BrokerOrder> {
    void _cmd;
    this.err();
  }
  async cancelOrder(_id: string): Promise<void> {
    void _id;
    this.err();
  }
  async modifyOrder(_id: string, _patch?: { quantity?: number; limitPrice?: number | null }): Promise<void> {
    void _id;
    void _patch;
    this.err();
  }
  // Legacy aliases.
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

/** Factory: only 'sim' resolves. Anything else throws (kite stays disabled). */
export function createBroker(kind: string): BrokerPort {
  if (kind === 'sim') {
    throw new Error("use BrokerSim directly; factory only guards: kind must be 'sim'");
  }
  throw new Phase1DisabledError(`broker-kind:${kind}`);
}
