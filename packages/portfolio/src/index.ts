// @aurix/portfolio — deterministic portfolio construction, allocation and risk
// (Phase 7). Hypothetical vocabulary only. No broker, no execution, no LLM.
export type {
  RiskVerdictValue, DrawdownState, RebalanceIntent, PortfolioFlowStatus,
  AllocationMethod, SizingMethod, InstrumentRef, PortfolioCandidate, PositionView,
  CapitalProfile, CapitalState, PortfolioState, AllocationResult, SizingResult,
  RiskDecision, RiskEvaluation, RebalanceLine, PortfolioDecision, DataQualityMap,
  MarketSnapshot, PipelineRequest
} from './types.js';
export { buildCapital, computeExposure, concentration, sectorExposure, correlationView } from './capital.js';
export type { Exposure, CorrelationView } from './capital.js';
export { allocateEqual, allocateSignal, allocateInverseVol, allocateConfidence, allocateHybrid, ALLOCATORS } from './allocation.js';
export type { AllocationInputs } from './allocation.js';
export { evaluatePortfolioRisk, drawdownState, PHASE1_DEFAULTS } from './risk.js';
export type { RiskPolicyInput, CandidateRiskInput, PortfolioRiskInput, CandidateRiskVerdict, PortfolioRiskResult } from './risk.js';
export { sizeFixedFraction, sizeVolatilityTarget, sizeRiskBudget, sizeMaxLoss, sizeLiquidityConstrained, finalizeSize } from './sizing.js';
export type { SizingInputs } from './sizing.js';
export { diffRebalance, applyTurnoverBudget, markToMarket, summarizeDecision, buildSnapshot } from './rebalance.js';
export type { RebalanceInput, MarkResult } from './rebalance.js';
