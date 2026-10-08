import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_LIVE_ENABLED,
  assertTransition,
  brokerStatusToOrderState,
  buildIdempotencyKey,
  canTransition,
  classifyRetry,
  evaluateLiveGate,
  isAutonomousLiveEnabled,
  isDuplicateIntent,
  isSupportedOrderType,
  looksLikeSecret,
  redactSecrets,
  type ExecutionRequest
} from '../src/index.js';

function req(over: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: 'r1', portfolioDecisionId: 'pdec-1', portfolioVersion: 1,
    candidateId: 'cand-1', positionId: null, desiredAction: 'BUY',
    instrumentId: 'NSE_EQ_RELIANCE', exchange: 'NSE', segment: 'EQ',
    side: 'BUY', quantity: 10, orderType: 'LIMIT', limitPrice: 100,
    triggerPrice: null, timeInForce: 'DAY', expectedNotional: 1000,
    strategyId: 's1', strategyVersion: 1, riskDecisionId: 'risk-1',
    riskVerdictAllow: true, riskCappedQty: 10, riskPolicyVersion: 'v1',
    safetyGateResult: 'PENDING', requestedAt: 1000, configVersion: 'exec-policy-v1',
    traceId: 't1', idempotencyKey: 'k1', executionMode: 'SIMULATION', ...over
  };
}

describe('execution-interface lifecycle', () => {
  it('has 15 canonical states', async () => {
    const { ORDER_STATES } = await import('../src/index.js');
    expect(ORDER_STATES).toHaveLength(15);
  });
  it('UNKNOWN must go through RECONCILING', () => {
    expect(canTransition('UNKNOWN', 'RECONCILING')).toBe(true);
    expect(canTransition('UNKNOWN', 'FILLED')).toBe(false);
    expect(canTransition('UNKNOWN', 'REJECTED')).toBe(false);
    expect(canTransition('SUBMITTED', 'FILLED')).toBe(false);
    expect(() => assertTransition('SUBMITTED', 'FILLED')).toThrow(/not a legal/);
  });
  it('happy path transitions are legal', () => {
    expect(canTransition('CREATED', 'VALIDATING')).toBe(true);
    expect(canTransition('VALIDATING', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'SUBMITTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'ACKNOWLEDGED')).toBe(true);
    expect(canTransition('ACKNOWLEDGED', 'PARTIALLY_FILLED')).toBe(true);
    expect(canTransition('PARTIALLY_FILLED', 'FILLED')).toBe(true);
    expect(canTransition('RECONCILING', 'RECONCILED')).toBe(true);
  });
  it('terminal states have no outgoing', () => {
    for (const s of ['REJECTED', 'FILLED', 'CANCELLED', 'EXPIRED', 'BROKER_REJECTED', 'RECONCILED'] as const) {
      expect(canTransition(s, 'RECONCILING')).toBe(false);
    }
  });
  it('same-state is not a transition', () => {
    expect(canTransition('FILLED', 'FILLED')).toBe(false);
  });
});

describe('idempotency + duplicates', () => {
  it('builds stable idempotency keys', () => {
    const k = buildIdempotencyKey({
      portfolioDecisionId: 'p', instrumentId: 'i', side: 'BUY',
      quantity: 10, orderType: 'LIMIT', strategyId: 's', traceId: 't'
    });
    expect(k).toBe('p|i|BUY|10|LIMIT|s|t');
  });
  it('detects duplicate intent within window', () => {
    const a = req({ idempotencyKey: 'k1', requestedAt: 1000 });
    const b = req({ idempotencyKey: 'k1', requestedAt: 2000 });
    expect(isDuplicateIntent(a, b)).toBe(true);
    const c = req({ idempotencyKey: 'k2', quantity: 99, requestedAt: 1000 });
    expect(isDuplicateIntent(a, c)).toBe(false);
  });
  it('supports only MARKET/LIMIT', () => {
    expect(isSupportedOrderType('MARKET')).toBe(true);
    expect(isSupportedOrderType('LIMIT')).toBe(true);
    expect(isSupportedOrderType('STOP')).toBe(false);
    expect(isSupportedOrderType('STOP_LIMIT')).toBe(false);
  });
});

describe('retry classification', () => {
  it('ambiguous -> RECONCILE_FIRST', () => {
    expect(classifyRetry('TIMEOUT')).toBe('RECONCILE_FIRST');
    expect(classifyRetry('RATE_LIMIT')).toBe('RECONCILE_FIRST');
    expect(classifyRetry('OUTAGE')).toBe('RECONCILE_FIRST');
    expect(classifyRetry('UNKNOWN')).toBe('RECONCILE_FIRST');
  });
  it('invalid -> DO_NOT_RETRY', () => {
    expect(classifyRetry('INVALID_ORDER')).toBe('DO_NOT_RETRY');
    expect(classifyRetry('BROKER_REJECTION')).toBe('DO_NOT_RETRY');
    expect(classifyRetry('MALFORMED_RESPONSE')).toBe('DO_NOT_RETRY');
    expect(classifyRetry('PERMISSION')).toBe('DO_NOT_RETRY');
  });
});

describe('broker status mapping', () => {
  it('maps broker truth to canonical states', () => {
    expect(brokerStatusToOrderState('FILLED', 10, 10)).toBe('FILLED');
    expect(brokerStatusToOrderState('PARTIAL', 5, 10)).toBe('PARTIALLY_FILLED');
    expect(brokerStatusToOrderState('CANCELLED', 0, 10)).toBe('CANCELLED');
    expect(brokerStatusToOrderState('REJECTED', 0, 10)).toBe('BROKER_REJECTED');
    expect(brokerStatusToOrderState('OPEN', 0, 10)).toBe('ACKNOWLEDGED');
  });
});

describe('live containment', () => {
  it('AUTONOMOUS_LIVE stays disabled', () => {
    expect(AUTONOMOUS_LIVE_ENABLED).toBe(false);
    expect(isAutonomousLiveEnabled()).toBe(false);
  });
  it('live gate never allows', () => {
    const r = evaluateLiveGate({
      mode: 'PAPER', promotionActive: true, operatorEnabled: true, riskConfigured: true,
      brokerAuthenticated: true, healthOk: true, reconcileReady: true, killSwitchReady: true, explicitLiveFlag: true
    });
    expect(r.allowed).toBe(false);
  });
});

describe('secret redaction', () => {
  it('redacts secret-shaped keys', () => {
    expect(looksLikeSecret('api_secret')).toBe(true);
    expect(looksLikeSecret('accessToken')).toBe(true);
    expect(looksLikeSecret('quantity')).toBe(false);
    const red = redactSecrets({ api_secret: 'shhh', quantity: 10, nested: { refresh_token: 'x' } });
    expect(red.api_secret).toBe('[REDACTED]');
    expect(red.quantity).toBe(10);
  });
});
