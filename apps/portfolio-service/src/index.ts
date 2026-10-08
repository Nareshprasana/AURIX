// @aurix/portfolio-service — hypothetical portfolio pipeline (Phase 7).
// Candidates → construction → allocation → risk → rebalance → decision.
// No broker, no execution, no live state. Risk verdicts are final.
export { PortfolioService, PORTFOLIO_CODE_VERSION } from './service.js';
export type { PipelineResult } from './service.js';
export type { PipelineRequest } from '@aurix/portfolio';
