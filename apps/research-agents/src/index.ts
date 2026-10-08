// @aurix/research-agents — memory-first specialist research (Phase 5).
// Observations and conclusions only; no trade decisions, no broker access.
export { ResearchOrchestrator, selectAgents } from './orchestrator.js';
export type { ResearchRequest, InvestigationOutcome } from './orchestrator.js';
export { buildResearchContext, type ResearchContextRequest } from './context.js';
export { authorityOf, filterEvidence, type FilteredEvidence } from './sources.js';
export {
  blankResult, observation, nextObservationId, nextEvidenceId, resetAgentSequences
} from './types.js';
export type { AgentContext, Interpreter, ResearchAgent, ResearchTaskRef } from './types.js';
export { FundamentalAgent } from './agents/fundamental.js';
export { TechnicalAgent } from './agents/technical.js';
export { ValuationAgent } from './agents/valuation.js';
export { SentimentAgent, classifySentiment } from './agents/sentiment.js';
export { MacroAgent } from './agents/macro.js';
export { EventIntelligenceAgent } from './agents/events.js';
