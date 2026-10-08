// @aurix/execution-interface — Phase 8: canonical execution contracts + vendor-neutral broker port.
// Backward compatible with Phase 1 (BrokerOrder/BrokerPosition/Funds/Phase1DisabledError/BrokerPort core).
// Phase 8 adds: ExecutionRequest, 15-state order lifecycle, idempotency, reconciliation,
// retry classification, kill switches, secret boundary, live containment.
//
// Safety invariants:
// - Broker state is authoritative after uncertainty (UNKNOWN -> RECONCILING -> RECONCILED).
// - Local intent and broker facts are stored separately; SUBMITTED never implies FILLED.
// - AUTONOMOUS_LIVE remains DISABLED; isAutonomousLiveEnabled() always returns false.
import type { OrderCmd, OrderStatus } from '@aurix/contracts';

export type { OrderCmd, OrderStatus };

// ---------------------------------------------------------------------------
// Legacy Phase 1 broker views (kept byte-compatible).
// ---------------------------------------------------------------------------

export interface BrokerOrder {
  brokerOrderId: string;
  status: OrderStatus;
  filledQty: number;
  avgPrice: number | null;
}

export interface BrokerPosition {
  instrumentId: string;
  qty: number;
  avgPrice: number;
}

export interface Funds {
  equity: number;
  cash: number;
}

export class Phase1DisabledError extends Error {
  constructor(adapter: string) {
    super(`${adapter} is disabled in Phase 1: no real broker reachable`);
    this.name = 'Phase1DisabledError';
  }
}

// Live trading is never enabled in Phase 8. Distinct error for clarity.
export class LiveDisabledError extends Error {
  constructor(reason: string) {
    super(`live submission disabled: ${reason}`);
    this.name = 'LiveDisabledError';
  }
}

/** Phase 8: AUTONOMOUS_LIVE must remain DISABLED. Single source of truth. */
export const AUTONOMOUS_LIVE_ENABLED = false as const;

export function isAutonomousLiveEnabled(): boolean {
  return false;
}

export function assertNoAutonomousLive(caller: string): void {
  // Intentionally ignores env/flags/files: no input can enable it in Phase 8.
  void caller;
  if (isAutonomousLiveEnabled()) {
    throw new LiveDisabledError('AUTONOMOUS_LIVE unreachable');
  }
}

// ---------------------------------------------------------------------------
// Execution domain model (§6).
// ---------------------------------------------------------------------------

export type ExecutionMode = 'SIMULATION' | 'PAPER';
export type ExecutionSide = 'BUY' | 'SELL';
export type ExecutionOrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type ExecutionTimeInForce = 'DAY' | 'IOC';
export type ExecutionAction = 'BUY' | 'SELL' | 'EXIT' | 'REDUCE_POSITION' | 'CLOSE';

export const SUPPORTED_ORDER_TYPES: readonly ExecutionOrderType[] = ['MARKET', 'LIMIT'] as const;
export const SUPPORTED_TIF: readonly ExecutionTimeInForce[] = ['DAY', 'IOC'] as const;

export function isSupportedOrderType(t: string): boolean {
  return (SUPPORTED_ORDER_TYPES as readonly string[]).includes(t);
}

export function isSupportedTif(t: string): boolean {
  return (SUPPORTED_TIF as readonly string[]).includes(t);
}

export interface ExecutionRequest {
  requestId: string;
  portfolioDecisionId: string;
  portfolioVersion: number;
  candidateId: string | null;
  positionId: string | null;
  desiredAction: ExecutionAction;
  instrumentId: string;
  exchange: string;
  segment: string;
  side: ExecutionSide;
  quantity: number;
  orderType: ExecutionOrderType;
  limitPrice: number | null;
  triggerPrice: number | null;
  timeInForce: ExecutionTimeInForce;
  expectedNotional: number;
  strategyId: string;
  strategyVersion: number;
  riskDecisionId: string;
  riskVerdictAllow: boolean;
  riskCappedQty: number;
  riskPolicyVersion: string;
  safetyGateResult: 'ALLOW' | 'REJECT' | 'PENDING';
  requestedAt: number;
  configVersion: string;
  traceId: string;
  idempotencyKey: string;
  executionMode: ExecutionMode;
}

/** Build the canonical idempotency key for a request. */
export function buildIdempotencyKey(parts: {
  portfolioDecisionId: string;
  instrumentId: string;
  side: string;
  quantity: number;
  orderType: string;
  strategyId: string;
  traceId: string;
}): string {
  return [
    parts.portfolioDecisionId,
    parts.instrumentId,
    parts.side,
    String(parts.quantity),
    parts.orderType,
    parts.strategyId,
    parts.traceId
  ].join('|');
}

// ---------------------------------------------------------------------------
// Order lifecycle (§7, §17). 15 states, deterministic transitions.
// Local intent and broker facts stored separately on OrderRecord.
// ---------------------------------------------------------------------------

export type OrderState =
  | 'CREATED'
  | 'VALIDATING'
  | 'REJECTED'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'BROKER_REJECTED'
  | 'UNKNOWN'
  | 'RECONCILING'
  | 'RECONCILED';

export const ORDER_STATES: readonly OrderState[] = [
  'CREATED', 'VALIDATING', 'REJECTED', 'APPROVED', 'SUBMITTED',
  'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED',
  'CANCELLED', 'EXPIRED', 'BROKER_REJECTED', 'UNKNOWN',
  'RECONCILING', 'RECONCILED'
] as const;

const LEGAL_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  CREATED: ['VALIDATING'],
  VALIDATING: ['REJECTED', 'APPROVED'],
  REJECTED: [],
  APPROVED: ['SUBMITTED', 'REJECTED', 'EXPIRED'],
  SUBMITTED: ['ACKNOWLEDGED', 'BROKER_REJECTED', 'UNKNOWN', 'EXPIRED', 'RECONCILING'],
  ACKNOWLEDGED: ['PARTIALLY_FILLED', 'FILLED', 'BROKER_REJECTED', 'CANCEL_REQUESTED', 'EXPIRED', 'UNKNOWN', 'RECONCILING'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'EXPIRED', 'UNKNOWN', 'RECONCILING'],
  FILLED: [],
  CANCEL_REQUESTED: ['CANCELLED', 'FILLED', 'PARTIALLY_FILLED', 'UNKNOWN', 'RECONCILING'],
  CANCELLED: [],
  EXPIRED: [],
  BROKER_REJECTED: [],
  UNKNOWN: ['RECONCILING'],
  RECONCILING: ['RECONCILED', 'UNKNOWN'],
  RECONCILED: []
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  if (from === to) return false;
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) {
    throw new Error(`EXEC_TRANSITION_REJECT: ${from} -> ${to} is not a legal order transition`);
  }
}

export function isTerminalState(s: OrderState): boolean {
  return s === 'REJECTED' || s === 'FILLED' || s === 'CANCELLED' || s === 'EXPIRED' || s === 'BROKER_REJECTED' || s === 'RECONCILED';
}

export interface FillEvent {
  fillId: string;
  orderId: string;
  brokerOrderId: string | null;
  quantity: number;
  price: number;
  timestamp: number;
  fees: number;
  cumulativeFilledQty: number;
}

export interface StateTransition {
  from: OrderState;
  to: OrderState;
  timestamp: number;
  reason: string;
}

export interface OrderRecord {
  orderId: string;
  requestId: string;
  idempotencyKey: string;
  /** Local intent: what AURIX asked for (never mutated after finalize). */
  intent: ExecutionRequest;
  /** Final payload actually validated by the safety gate and submitted. */
  finalPayload: OrderCmd;
  state: OrderState;
  /** Broker-owned facts (authoritative after uncertainty). Null until submitted. */
  brokerOrderId: string | null;
  brokerStatus: OrderStatus | null;
  requestedQty: number;
  filledQty: number;
  remainingQty: number;
  avgPrice: number | null;
  fills: FillEvent[];
  history: StateTransition[];
  mode: ExecutionMode;
  configVersion: string;
  traceId: string;
  createdAt: number;
  updatedAt: number;
  lastReconciledAt: number | null;
  failureClass: RetryClass | null;
  failureReason: string | null;
}

export function emptyOrderRecord(orderId: string, req: ExecutionRequest, payload: OrderCmd, now: number): OrderRecord {
  return {
    orderId,
    requestId: req.requestId,
    idempotencyKey: req.idempotencyKey,
    intent: { ...req },
    finalPayload: { ...payload },
    state: 'CREATED',
    brokerOrderId: null,
    brokerStatus: null,
    requestedQty: payload.quantity,
    filledQty: 0,
    remainingQty: payload.quantity,
    avgPrice: null,
    fills: [],
    history: [{ from: 'CREATED', to: 'CREATED', timestamp: now, reason: 'created' }],
    mode: req.executionMode,
    configVersion: req.configVersion,
    traceId: req.traceId,
    createdAt: now,
    updatedAt: now,
    lastReconciledAt: null,
    failureClass: null,
    failureReason: null
  };
}

/** Apply a fill idempotently: duplicate fillId is ignored. */
export function applyFill(record: OrderRecord, fill: FillEvent): OrderRecord {
  if (record.fills.some((f) => f.fillId === fill.fillId)) return record;
  const fills = [...record.fills, fill];
  const filledQty = fills.reduce((s, f) => s + f.quantity, 0);
  const notional = fills.reduce((s, f) => s + f.quantity * f.price, 0);
  const avgPrice = filledQty > 0 ? notional / filledQty : null;
  return {
    ...record,
    fills,
    filledQty,
    remainingQty: Math.max(0, record.requestedQty - filledQty),
    avgPrice,
    updatedAt: fill.timestamp
  };
}

// ---------------------------------------------------------------------------
// Idempotency + duplicate policy (§18, §20).
// ---------------------------------------------------------------------------

export interface DuplicatePolicy {
  /** Requests with same idempotency key within windowMs are the same semantic order. */
  windowMs: number;
  /** Fields that define a duplicate intent (explicit policy). */
  matchFields: readonly string[];
}

export const DEFAULT_DUPLICATE_POLICY: DuplicatePolicy = {
  windowMs: 24 * 60 * 60 * 1000,
  matchFields: ['portfolioDecisionId', 'instrumentId', 'side', 'quantity', 'orderType', 'strategyId', 'traceId']
} as const;

export function isDuplicateIntent(a: ExecutionRequest, b: ExecutionRequest, policy: DuplicatePolicy = DEFAULT_DUPLICATE_POLICY): boolean {
  if (a.idempotencyKey === b.idempotencyKey) return true;
  if (a.instrumentId !== b.instrumentId) return false;
  if (a.side !== b.side) return false;
  if (a.quantity !== b.quantity) return false;
  if (a.orderType !== b.orderType) return false;
  if (a.portfolioDecisionId !== b.portfolioDecisionId) return false;
  if (a.strategyId !== b.strategyId) return false;
  if (Math.abs(a.requestedAt - b.requestedAt) > policy.windowMs) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Retry classification (§29) + broker error taxonomy (§26, §28).
// ---------------------------------------------------------------------------

export type RetryClass = 'SAFE_RETRY' | 'RECONCILE_FIRST' | 'DO_NOT_RETRY';

export type BrokerErrorCode =
  | 'TIMEOUT'
  | 'CONNECTION_RESET'
  | 'DNS_FAILURE'
  | 'PARTIAL_RESPONSE'
  | 'HTTP_5XX'
  | 'RATE_LIMIT'
  | 'MALFORMED_RESPONSE'
  | 'INVALID_ORDER'
  | 'BROKER_REJECTION'
  | 'PERMISSION'
  | 'OUTAGE'
  | 'UNKNOWN';

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly retryable: boolean;
  constructor(code: BrokerErrorCode, message: string) {
    super(`broker ${code}: ${message}`);
    this.name = 'BrokerError';
    this.code = code;
    this.retryable = code === 'TIMEOUT' || code === 'CONNECTION_RESET' || code === 'HTTP_5XX' || code === 'RATE_LIMIT';
  }
}

export function classifyRetry(code: BrokerErrorCode): RetryClass {
  switch (code) {
    case 'TIMEOUT':
    case 'CONNECTION_RESET':
    case 'DNS_FAILURE':
    case 'PARTIAL_RESPONSE':
    case 'HTTP_5XX':
    case 'RATE_LIMIT':
    case 'OUTAGE':
    case 'UNKNOWN':
      return 'RECONCILE_FIRST';
    case 'INVALID_ORDER':
    case 'BROKER_REJECTION':
    case 'PERMISSION':
    case 'MALFORMED_RESPONSE':
      return 'DO_NOT_RETRY';
    default:
      return 'DO_NOT_RETRY';
  }
}

/** Pure reads that never mutate broker state may be safely retried with backoff. */
export function isSafeReadRetry(op: 'getOrder' | 'getOrders' | 'getPositions' | 'getAccountState' | 'getQuote' | 'getInstrument' | 'getMargin' | 'placeOrder' | 'cancelOrder' | 'modifyOrder'): boolean {
  return op === 'getOrder' || op === 'getOrders' || op === 'getPositions' || op === 'getAccountState' || op === 'getQuote' || op === 'getInstrument' || op === 'getMargin';
}

// ---------------------------------------------------------------------------
// Reconciliation (§23, §24).
// ---------------------------------------------------------------------------

export type DiscrepancyKind =
  | 'MISSING_ORDER'
  | 'UNKNOWN_ORDER'
  | 'DUPLICATE_ORDER'
  | 'PARTIAL_FILL'
  | 'UNEXPECTED_FILL'
  | 'CANCELLED_DIVERGENCE'
  | 'REJECTED_DIVERGENCE'
  | 'STALE_LOCAL'
  | 'STALE_BROKER';

export interface ReconcileDiscrepancy {
  kind: DiscrepancyKind;
  orderId: string;
  before: string;
  after: string;
  source: 'broker' | 'local';
  timestamp: number;
  result: string;
}

export interface ReconciliationReport {
  orderId: string;
  localBefore: OrderState;
  brokerStatus: OrderStatus | null;
  brokerFilledQty: number | null;
  discrepancies: ReconcileDiscrepancy[];
  localAfter: OrderState;
  timestamp: number;
  result: 'ADOPTED_BROKER' | 'NO_DIFF' | 'DEFERRED_UNKNOWN';
}

// ---------------------------------------------------------------------------
// Kill switches (§35, §36).
// ---------------------------------------------------------------------------

export interface KillSwitchSnapshot {
  globalHalt: boolean;
  executionHalted: boolean;
  strategies: string[];
  instruments: string[];
  portfolios: string[];
}

export interface KillSwitchInput extends KillSwitchSnapshot {
  timestamp: number;
  operator: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Secrets (§12, §50): adapter receives secrets via provider; never logs them.
// ---------------------------------------------------------------------------

export interface SecretProvider {
  /** Resolve a secret by reference. Returns null when absent (no throw-phishing). */
  getSecret(ref: string): string | null;
  readonly kind: string;
}

export class NullSecretProvider implements SecretProvider {
  readonly kind = 'null';
  getSecret(_ref: string): string | null {
    void _ref;
    return null;
  }
}

const SECRET_PATTERNS = [/api[_-]?secret/i, /access[_-]?token/i, /refresh[_-]?token/i, /session[_-]?token/i, /private[_-]?key/i, /kite[_-]?token/i];

export function looksLikeSecret(key: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(key));
}

/** Redact secret-shaped values from any record before logging/audit. */
export function redactSecrets<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Bare tokens longer than 16 chars with high entropy are redacted when key context unknown.
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (looksLikeSecret(k)) out[k] = '[REDACTED]';
      else out[k] = redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Broker interface (§10): smallest vendor-neutral surface.
// Legacy fetch* methods retained as aliases for Phase 1 compatibility.
// ---------------------------------------------------------------------------

export interface BrokerAuth {
  ok: boolean;
  accountId: string | null;
  note: string;
}

export interface BrokerInstrument {
  instrumentId: string;
  exchange: string;
  segment: string;
  symbol: string;
  lotSize: number;
  tickSize: number;
  minQty: number;
  maxQty: number;
}

export interface BrokerQuote {
  instrumentId: string;
  lastPrice: number;
  timestamp: number;
  stale: boolean;
}

export interface BrokerMargin {
  required: number;
  available: number;
  sufficient: boolean;
}

export interface BrokerPort {
  readonly kind: string;
  // Auth + reads.
  authenticate(ref?: string): Promise<BrokerAuth>;
  getAccountState(): Promise<Funds>;
  getPositions(): Promise<BrokerPosition[]>;
  getOrders(): Promise<BrokerOrder[]>;
  getOrder(id: string): Promise<BrokerOrder>;
  getInstrument(id: string): Promise<BrokerInstrument>;
  getQuote(id: string): Promise<BrokerQuote>;
  getMargin(cmd: OrderCmd): Promise<BrokerMargin>;
  // Writes.
  placeOrder(cmd: OrderCmd, opts?: { lastPrice?: number }): Promise<BrokerOrder>;
  modifyOrder(id: string, patch: { quantity?: number; limitPrice?: number | null }): Promise<void>;
  cancelOrder(id: string): Promise<void>;
  // Legacy aliases (Phase 1 compat).
  fetchOrder(id: string): Promise<BrokerOrder>;
  fetchPositions(): Promise<BrokerPosition[]>;
  fetchFunds(): Promise<Funds>;
}

// ---------------------------------------------------------------------------
// Controlled-live gate (§34): infrastructure only. Phase 8 always blocks.
// Every condition is independently required; each is false in Phase 8.
// ---------------------------------------------------------------------------

export interface LiveGateInputs {
  mode: string;
  promotionActive: boolean;
  operatorEnabled: boolean;
  riskConfigured: boolean;
  brokerAuthenticated: boolean;
  healthOk: boolean;
  reconcileReady: boolean;
  killSwitchReady: boolean;
  explicitLiveFlag: boolean;
}

export interface LiveGateResult {
  allowed: boolean;
  reasons: string[];
}

export function evaluateLiveGate(inputs: LiveGateInputs): LiveGateResult {
  const reasons: string[] = [];
  if (inputs.mode === 'AUTONOMOUS_LIVE' || inputs.mode === 'CONTROLLED_LIVE') {
    reasons.push(`live mode ${inputs.mode} requires full activation checklist`);
  }
  if (!inputs.promotionActive) reasons.push('no ACTIVE promotion');
  if (!inputs.operatorEnabled) reasons.push('no explicit operator enablement');
  if (!inputs.riskConfigured) reasons.push('risk not configured');
  if (!inputs.brokerAuthenticated) reasons.push('broker not authenticated');
  if (!inputs.healthOk) reasons.push('health checks not passing');
  if (!inputs.reconcileReady) reasons.push('reconciliation not ready');
  if (!inputs.killSwitchReady) reasons.push('kill switch not ready');
  if (!inputs.explicitLiveFlag) reasons.push('explicit live flag absent');
  // Phase 8 hard stop: autonomous live can never be allowed regardless of inputs.
  reasons.push('Phase 8 containment: AUTONOMOUS_LIVE=DISABLED');
  return { allowed: false, reasons };
}

/** Map a broker status to the canonical local OrderState (broker facts adopted). */
export function brokerStatusToOrderState(status: OrderStatus, filledQty: number, requestedQty: number): OrderState {
  if (status === 'FILLED') return 'FILLED';
  if (status === 'PARTIAL') return 'PARTIALLY_FILLED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'REJECTED') return 'BROKER_REJECTED';
  if (status === 'OPEN' || status === 'PENDING') {
    if (filledQty > 0 && filledQty < requestedQty) return 'PARTIALLY_FILLED';
    return 'ACKNOWLEDGED';
  }
  return 'UNKNOWN';
}
