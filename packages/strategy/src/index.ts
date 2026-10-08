// @aurix/strategy — declarative strategy intelligence (Phase 6). Pure logic,
// no I/O, no broker, no execution, no LLM. Conditions are data, never code.
export type {
  StrategyFamily, StrategyStatus, SignalType, Applicability, IndicatorName,
  ConditionOperator, IndicatorRef, StrategyCondition, PositionSizing, CostModel,
  SlippageModel, LiquidityPolicy, RegimeSpec, StrategyScope, StrategyDefinition,
  StrategyHypothesis, Signal, RegimeState, HypotheticalOrder, Fill, Trade,
  PerformanceMetrics, EvaluationLabel, BacktestState
} from './types.js';
export { STATUS_ORDER } from './types.js';
export { sma, roc, stdevLogReturns, stdevPrices, donchian, zscore } from './indicators.js';
export { evaluateIndicator, evaluateCondition, FAMILY_PRESETS, registerFamily, validateDefinition } from './families.js';
export type { FamilyPreset } from './families.js';
export { classifyRegime, checkApplicability } from './regime.js';
export { computeCost, computeSlippage, checkLiquidity, TradingCalendar, dateStr } from './costs.js';
export type { CostBreakdown, SlippageResult, LiquidityCheck } from './costs.js';
export { computeMetrics, compareBenchmark, evaluateStrategy } from './metrics.js';
export type { BenchmarkComparison, EvaluationInput } from './metrics.js';
export { generateSignals } from './signals.js';
export type { SignalBatch } from './signals.js';
