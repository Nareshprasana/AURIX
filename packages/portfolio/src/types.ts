// Portfolio domain contracts. Hypothetical vocabulary only: target positions,
// weights, intents — never broker orders. Risk decisions are ALLOW/REDUCE/
// REJECT/UNKNOWN; UNKNOWN never becomes ALLOW.
import type { SourceType } from '@aurix/contracts';

export type RiskVerdictValue = 'ALLOW' | 'REDUCE' | 'REJECT' | 'UNKNOWN';
export type DrawdownState = 'NORMAL' | 'CAUTION' | 'RESTRICTED' | 'HALTED';
export type RebalanceIntent = 'BUY' | 'SELL' | 'REDUCE' | 'INCREASE' | 'HOLD' | 'NO_CHANGE' | 'BLOCKED';
export type PortfolioFlowStatus =
  | 'READY' | 'CALCULATING' | 'COMPLETED' | 'PARTIAL' | 'INSUFFICIENT_DATA'
  | 'RISK_BLOCKED' | 'DATA_QUARANTINED' | 'UNKNOWN' | 'FAILED';
export type AllocationMethod = 'equal' | 'signal' | 'risk' | 'volatility' | 'confidence' | 'hybrid';
export type SizingMethod = 'fixed-fraction' | 'volatility-target' | 'risk-budget' | 'max-loss' | 'liquidity-constrained';

export interface InstrumentRef {
  instrument_id: string;
  exchange: string;
  market: string;
  segment: string;
  symbol: string;
}

export interface PortfolioCandidate {
  candidate_id: string;
  instrument: InstrumentRef;
  strategy_id: string;
  strategy_version: number;
  signal_type: 'LONG' | 'SHORT' | 'EXIT' | 'HOLD' | 'NO_SIGNAL';
  signal_strength: number;
  signal_confidence: number;
  expected_horizon_bars: number;
  evidence_refs: string[];
  regime: string;
  liquidity: { adv_value: number | null; spread_bps: number | null; volume: number | null };
  direction: 1 | -1;
  reference_price: number;
  invalidation: string[];
}

export interface PositionView {
  position_id: string;
  instrument_id: string;
  qty: number;
  side: 1 | -1 | 0;
  avg_price: number;
  mark_price: number;
  market_value: number;
  weight_pct: number;
  realized_pnl: number;
  unrealized_pnl: number;
  strategy_id: string;
  strategy_version: number;
  sector: string | null;
  asset_class: string;
  liquidity: { adv_value: number | null; spread_bps: number | null };
  updated_at: number;
}

export interface CapitalProfile {
  total: number;
  reserved_pct: number;
  base_currency: string;
}

export interface CapitalState {
  total: number;
  cash: number;
  invested: number;
  available: number;
  reserved: number;
  margin_used: number;
  free_margin: number;
  gross_exposure: number;
  net_exposure: number;
}

export interface PortfolioState {
  portfolio_id: string;
  version: number;
  capital: CapitalState;
  positions: PositionView[];
  realized_pnl: number;
  unrealized_pnl: number;
  drawdown_pct: number;
  peak_equity: number;
  daily_pnl_pct: number;
  drawdown_state: DrawdownState;
  status: string;
  updated_at: number;
  provenance: { source: string; source_type: SourceType; evidence_refs: string[] };
}

export interface AllocationResult {
  method: AllocationMethod;
  weights: Record<string, number>;
  capped: { instrument_id: string; requested: number; capped: number; reason: string }[];
  explanation: string[];
}

export interface SizingResult {
  method: SizingMethod;
  instrument_id: string;
  qty: number;
  notional: number;
  inputs: Record<string, number>;
  capped_by: string[];
  explanation: string;
}

export interface RiskDecision {
  decision_id: string;
  portfolio_id: string;
  candidate_id: string | null;
  rule_id: string;
  observed: number | null;
  limit: number | null;
  utilization_pct: number | null;
  decision: RiskVerdictValue;
  explanation: string;
  timestamp: number;
  config_version: string;
  evidence_ref: string | null;
  trace_id: string;
}

export interface RiskEvaluation {
  candidate_id: string;
  decisions: RiskDecision[];
  verdict: RiskVerdictValue;
  approved_qty: number;
  reasons: string[];
}

export interface RebalanceLine {
  instrument_id: string;
  current_qty: number;
  target_qty: number;
  delta_qty: number;
  intent: RebalanceIntent;
  est_cost: number;
  reason: string;
}

export interface PortfolioDecision {
  decision_id: string;
  timestamp: number;
  portfolio_id: string;
  portfolio_version: number;
  candidates: string[];
  proposed: Record<string, number>;
  approved: Record<string, number>;
  reduced: { instrument_id: string; from_qty: number; to_qty: number; rule_id: string }[];
  rejected: { instrument_id: string; rule_id: string; reason: string }[];
  risk_decisions: RiskDecision[];
  exposure: { gross_pct: number; net_pct: number; long_pct: number; short_pct: number };
  expected_turnover: number;
  estimated_costs: number;
  assumptions: string[];
  evidence_refs: string[];
  versions: Record<string, string>;
  outcome: 'TRADE' | 'NO_TRADE' | 'RISK_BLOCKED';
}

export interface DataQualityMap {
  [key: string]: 'VALID' | 'SUSPECT' | 'QUARANTINED' | 'STALE' | 'UNKNOWN' | 'MISSING';
}

export interface MarketSnapshot {
  prices: Record<string, number>;
  volumes: Record<string, number>;
  adv: Record<string, number | null>;
  spreads_bps: Record<string, number | null>;
  volatilities: Record<string, number | null>;
  correlations: Record<string, Record<string, number | null>>;
  sectors: Record<string, string | null>;
  quality: DataQualityMap;
  as_of: number;
}

export interface PipelineRequest {
  portfolio_id: string;
  candidates: PortfolioCandidate[];
  market: MarketSnapshot;
  current: PositionView[];
  capital: { total: number; reserved_pct: number; base_currency: string };
  peak_equity: number;
  prev_equity: number;
  allocation?: AllocationMethod;
  allocationInputs?: {
    volatilities?: Record<string, number>;
    maxWeightPct?: number;
    hybridWeights?: { signal: number; volatility: number; confidence: number; liquidity: number };
    liquidityScores?: Record<string, number>;
  };
  drawdown_override?: number;
  daily_pnl_override?: number;
  strategyAuth?: Record<string, boolean>;
  modeAllowsOrders?: boolean;
  correlations?: Record<string, Record<string, number | null>>;
  turnoverBudgetPct?: number;
  actor: string;
  trace_id: string;
  now?: number;
}
