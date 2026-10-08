// Strategy domain contracts. Declarative definitions only: conditions are data
// evaluated by a fixed operator set — never arbitrary executable code. Signals
// are LONG/SHORT/EXIT/HOLD/NO_SIGNAL/INVALID; there are no broker commands here.
import type { SourceType } from '@aurix/contracts';

export type StrategyFamily =
  | 'momentum' | 'trend' | 'mean-reversion' | 'breakout'
  | 'event' | 'fundamental' | 'statistical' | 'volatility';

export type StrategyStatus =
  | 'HYPOTHESIS' | 'CANDIDATE' | 'BACKTESTED' | 'OOS_VALIDATED'
  | 'WALK_FORWARD_VALIDATED' | 'STRESS_TESTED' | 'PAPER_ELIGIBLE'
  | 'APPROVED' | 'REJECTED' | 'DEGRADED' | 'RETIRED';

export const STATUS_ORDER: StrategyStatus[] = [
  'HYPOTHESIS', 'CANDIDATE', 'BACKTESTED', 'OOS_VALIDATED',
  'WALK_FORWARD_VALIDATED', 'STRESS_TESTED', 'PAPER_ELIGIBLE', 'APPROVED'
];

export type SignalType = 'LONG' | 'SHORT' | 'EXIT' | 'HOLD' | 'NO_SIGNAL' | 'INVALID';
export type Applicability = 'APPLICABLE' | 'NOT_APPLICABLE';

export type IndicatorName = 'price' | 'sma' | 'roc' | 'stdev' | 'zscore' | 'donchian_high' | 'donchian_low';
export type ConditionOperator = 'crosses_above' | 'crosses_below' | 'above' | 'below';

export interface IndicatorRef {
  indicator: IndicatorName;
  params?: Record<string, number>;
}

export interface StrategyCondition {
  left: IndicatorRef;
  operator: ConditionOperator;
  right: IndicatorRef | { const: number };
}

export interface PositionSizing {
  type: 'fixed-qty' | 'fixed-notional';
  qty?: number;
  notional?: number;
  max_notional: number;
  max_adv_pct: number;
}

export interface CostModel {
  brokerage_bps: number;
  exchange_bps: number;
  taxes_bps: number;
  min_cost: number;
  per_side: boolean;
}

export interface SlippageModel {
  kind: 'fixed-bps' | 'liquidity-aware';
  base_bps: number;
  spread_share?: number;
  impact_coeff?: number;
  assumed_spread_bps?: number;
}

export interface LiquidityPolicy {
  min_value: number;
  min_volume: number;
  max_participation: number;
  max_adv_pct: number;
  max_spread_bps: number;
}

export interface RegimeSpec {
  supported: string[];
  preferred: string[];
  blocked: string[];
}

export interface StrategyScope {
  markets: string[];
  segments: string[];
  timeframes: string[];
  universe: string[];
}

export interface StrategyDefinition {
  id: string;
  version: number;
  name: string;
  description: string;
  family: StrategyFamily;
  scope: StrategyScope;
  entry_long: StrategyCondition;
  entry_short: StrategyCondition;
  exit: StrategyCondition;
  sizing: PositionSizing;
  signal_horizon_bars: number;
  required_observations: string[];
  required_data: string[];
  required_events: string[];
  assumptions: string[];
  cost_model: CostModel;
  slippage_model: SlippageModel;
  liquidity: LiquidityPolicy;
  regimes: RegimeSpec;
  params: Record<string, number>;
  param_bounds: Record<string, [number, number]>;
  family_preset?: string;
  created_at: number;
  author: string;
  provenance: { source: string; source_type: SourceType; evidence_refs: string[] };
  evidence_refs: string[];
  status: StrategyStatus;
  parent?: { id: string; version: number };
}

export interface StrategyHypothesis {
  hypothesis_id: string;
  research_inputs: string[];
  observations: string[];
  mechanism: string;
  target_regime: string;
  expected_signal: string;
  expected_behavior: string;
  falsification: string;
  assumptions: string[];
  evidence: string[];
  confidence: number;
  provenance: { source: string; source_type: SourceType; evidence_refs: string[] };
  created_at: number;
  author: string;
}

export interface Signal {
  strategy_id: string;
  strategy_version: number;
  instrument_id: string;
  ts: number;
  type: SignalType;
  direction: 1 | -1 | 0;
  strength: number;
  horizon_bars: number;
  ref_price: number;
  observations: string[];
  data_version: string;
  params: Record<string, number>;
  evidence: string[];
  confidence: number;
  regime: string;
  generated_at: number;
  note?: string;
}

export interface RegimeState {
  trend: 'up' | 'down' | 'flat';
  volatility: 'high' | 'low';
  label: string;
  abnormal: boolean;
}

export interface HypotheticalOrder {
  id: string;
  strategy_id: string;
  strategy_version: number;
  instrument_id: string;
  ts_signal: number;
  ts_execute: number;
  side: 'BUY' | 'SELL' | 'EXIT_LONG' | 'EXIT_SHORT';
  qty: number;
  ref_price: number;
  reason: string;
}

export interface Fill {
  order_id: string;
  instrument_id: string;
  ts: number;
  price: number;
  qty: number;
  fees: number;
  fee_breakdown: { brokerage: number; exchange: number; taxes: number };
  slippage_bps: number;
  slippage_assumptions: string[];
  liquidity_capped: boolean;
}

export interface Trade {
  trade_id: string;
  instrument_id: string;
  direction: 1 | -1;
  entry_ts: number;
  entry_price: number;
  exit_ts: number | null;
  exit_price: number | null;
  qty: number;
  realized_pnl: number;
  fees: number;
  holding_bars: number;
  status: 'OPEN' | 'CLOSED';
}

export interface PerformanceMetrics {
  total_return: number;
  cagr: number;
  volatility: number;
  max_drawdown: number;
  max_dd_duration_bars: number;
  downside_dev: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  trades: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  turnover: number;
  avg_holding_bars: number;
  worst_day: number;
  worst_trade: number;
  loss_streak: number;
  concentration: number;
}

export type EvaluationLabel =
  | 'REJECTED' | 'WEAK' | 'PROMISING' | 'ROBUST' | 'DEGRADED' | 'INSUFFICIENT_DATA' | 'INVALID';

export interface BacktestState {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'DATA_QUARANTINED' | 'INVALID' | 'FAILED' | 'CANCELLED';
  reason?: string;
}
