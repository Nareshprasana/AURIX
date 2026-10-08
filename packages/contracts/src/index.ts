// @aurix/contracts — generic, vendor/exchange-agnostic core model (Amendment 2).
// No venue-specific branches. NSE/BSE/MCX appear only as data values.

export type EligibilityState = 'LEGAL' | 'RESTRICTED' | 'UNAVAILABLE' | 'UNKNOWN';
export type MarketStatus = 'OPEN' | 'HALT' | 'AUCTION' | 'CLOSED' | 'UNKNOWN';
export type Mode = 'RESEARCH' | 'BACKTEST' | 'SHADOW' | 'PAPER' | 'CONTROLLED_LIVE' | 'AUTONOMOUS_LIVE';
export type DecisionAction = 'BUY' | 'SELL' | 'EXIT' | 'HOLD' | 'NO_TRADE' | 'REDUCE_POSITION';
export type KnowledgeLabel = 'FACT' | 'OBSERVATION' | 'INFERENCE' | 'HYPOTHESIS' | 'PREDICTION' | 'UNKNOWN';

export interface ContractSpec {
  kind: 'FUT' | 'CALL' | 'PUT' | 'SPOT';
  expiry?: string;
  strike?: number;
  optionType?: string;
}

export interface Instrument {
  id: string;
  exchange: string; // venue code as data value, never a code branch
  market: string; // e.g. 'equity', 'equity-derivatives'
  segment: string; // venue segment code, opaque
  symbol: string;
  isin: string | null;
  lot_size: number;
  tick_size: number;
  contract: ContractSpec | null;
  meta?: Record<string, unknown>;
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED';

export interface OrderCmd {
  clientOrderId: string; // idempotency key
  decisionId: string;
  instrumentId: string;
  exchange: string;
  segment: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice: number | null;
  strategyId: string;
}

export interface RiskVerdict {
  allow: boolean;
  cappedQty: number;
  reasons: string[];
  policyVersion: string;
}

export type SafetyVerdictValue = 'ALLOW' | 'REJECT';

export interface SafetyVerdict {
  verdict: SafetyVerdictValue;
  reasons: string[];
}

export interface SafetyContext {
  instrument: Instrument | null; // null = unknown instrument
  eligibility: EligibilityState;
  marketStatus: MarketStatus;
  riskVerdict: RiskVerdict | null; // null = missing
  mode: Mode;
  promotionActive: boolean;
  strategyAuthorized: boolean;
  riskHalted: boolean;
  nowTs: number;
  decisionTs: number;
  marketDataTs: number;
  decisionTtlS: number;
  marketDataStalenessS: number;
  seenIdempotencyKeys: Set<string> | string[];
  lastPrice: number | null;
  brokerMaxQty: number;
  brokerMinQty?: number;
}

export interface DecisionRecord {
  decision_id: string;
  ts: number;
  instrument: { exchange: string; market: string; segment: string; instrumentId: string };
  market_state: string;
  data_versions: Record<string, string>;
  evidence_refs: string[];
  knowledge_event_ids: string[];
  strategy: { id: string; version: string };
  model: { provider: string; model: string; promptVersion: string };
  risk: RiskVerdict;
  safety: SafetyVerdict;
  mode: Mode;
  promotion_id: string | null;
  execution: { routed: boolean; brokerOrderId: string | null; note: string };
  outcome: string | null;
}

export type PromotionState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export interface LiveTradingPromotion {
  promotion_id: string;
  system_version: string;
  risk_policy_version: string;
  model_version: string;
  strategy_versions: string[];
  validation_results_ref: string;
  paper_trading_results_ref: string;
  approval_timestamp: string | null;
  operator_identity: string | null;
  state: PromotionState;
}

export interface KnowledgeEvent {
  id: string;
  event_type: string;
  entity_ref: string;
  payload: Record<string, unknown>;
  actor: string;
  label_class: KnowledgeLabel;
  evidence_refs: string[];
  prev_version: string;
  new_version: string;
  device_id: string;
  created_at: number;
}

export interface BrokerConstraints {
  minQty: number;
  maxQty: number;
  priceLowerBound: number | null;
  priceUpperBound: number | null;
}
