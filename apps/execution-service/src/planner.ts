// @aurix/execution-service — planner (Phase 8 §6, §39, §40).
// Transforms an approved hypothetical portfolio decision into a validated
// execution request. Never mutates risk limits/verdicts; consumes them.

import {
  buildIdempotencyKey,
  type ExecutionAction,
  type ExecutionMode,
  type ExecutionOrderType,
  type ExecutionRequest,
  type ExecutionTimeInForce
} from '@aurix/execution-interface';

export interface PortfolioIntent {
  portfolioDecisionId: string;
  portfolioVersion: number;
  candidateId: string | null;
  positionId: string | null;
  desiredAction: ExecutionAction;
  instrumentId: string;
  exchange: string;
  segment: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: ExecutionOrderType;
  limitPrice?: number | null;
  triggerPrice?: number | null;
  timeInForce?: ExecutionTimeInForce;
  strategyId: string;
  strategyVersion: number;
  riskDecisionId: string;
  riskAllow: boolean;
  riskCappedQty: number;
  riskPolicyVersion: string;
  traceId: string;
  configVersion: string;
  requestedAt?: number;
  executionMode?: ExecutionMode;
}

let requestSeq = 0;

export function resetPlannerSeqForTests(): void {
  requestSeq = 0;
}

export function planExecutionRequest(intent: PortfolioIntent, now: () => number = Date.now): ExecutionRequest {
  const ts = intent.requestedAt ?? now();
  const seq = (requestSeq += 1);
  const requestId = `exec-req-${ts}-${seq}`;
  const tif = intent.timeInForce ?? 'DAY';
  const refPrice = intent.limitPrice ?? intent.triggerPrice ?? 0;
  const expectedNotional = refPrice > 0 ? refPrice * intent.quantity : 0;
  const executionMode = intent.executionMode ?? 'SIMULATION';
  const idempotencyKey = buildIdempotencyKey({
    portfolioDecisionId: intent.portfolioDecisionId,
    instrumentId: intent.instrumentId,
    side: intent.side,
    quantity: intent.quantity,
    orderType: intent.orderType,
    strategyId: intent.strategyId,
    traceId: intent.traceId
  });
  return {
    requestId,
    portfolioDecisionId: intent.portfolioDecisionId,
    portfolioVersion: intent.portfolioVersion,
    candidateId: intent.candidateId,
    positionId: intent.positionId,
    desiredAction: intent.desiredAction,
    instrumentId: intent.instrumentId,
    exchange: intent.exchange,
    segment: intent.segment,
    side: intent.side,
    quantity: intent.quantity,
    orderType: intent.orderType,
    limitPrice: intent.limitPrice ?? null,
    triggerPrice: intent.triggerPrice ?? null,
    timeInForce: tif,
    expectedNotional,
    strategyId: intent.strategyId,
    strategyVersion: intent.strategyVersion,
    riskDecisionId: intent.riskDecisionId,
    riskVerdictAllow: intent.riskAllow,
    riskCappedQty: intent.riskCappedQty,
    riskPolicyVersion: intent.riskPolicyVersion,
    safetyGateResult: 'PENDING',
    requestedAt: ts,
    configVersion: intent.configVersion,
    traceId: intent.traceId,
    idempotencyKey,
    executionMode
  };
}
