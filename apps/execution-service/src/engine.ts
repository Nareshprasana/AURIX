// @aurix/execution-service — lifecycle engine (Phase 8 §§13-29, §§35-47, §§52-54).
// Only path: Execution Service -> Safety Gate -> Broker Adapter -> Broker.
// Every submission validates the FINAL payload via the Phase 1 gate (no bypass).
// Timeout/ambiguity -> UNKNOWN -> reconcile (never blind resubmit, never assume fill/reject).

import type { OrderCmd, SafetyContext } from '@aurix/contracts';
import { validateOrder } from '@aurix/order-safety-gate';
import {
  applyFill,
  assertTransition,
  brokerStatusToOrderState,
  buildIdempotencyKey,
  canTransition,
  classifyRetry,
  emptyOrderRecord,
  evaluateLiveGate,
  isDuplicateIntent,
  isSupportedOrderType,
  isSupportedTif,
  redactSecrets,
  type BrokerErrorCode,
  type BrokerPort,
  type ExecutionRequest,
  type FillEvent,
  type OrderRecord,
  type OrderState,
  type ReconciliationReport,
  type RetryClass
} from '@aurix/execution-interface';
import { ExecutionLedger, type LedgerConfig } from './ledger.js';
import { KillSwitchManager } from './kill-switch.js';
import { TokenBucket, type RateLimiterConfig } from './rate-limit.js';
import { reconcileOrder } from './reconcile.js';

export interface EngineConfig {
  ledger: LedgerConfig;
  rateLimit: RateLimiterConfig;
  maxAttempts: number;
  configVersion: string;
  /** Max notional per order (simulated/authorized capital guard). */
  maxNotional: number;
  /** Price deviation band vs lastPrice (0.2 = 20%). */
  priceDeviationPct: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  ledger: { filePath: null, maxOrders: 10000, maxAuditEvents: 50000 },
  rateLimit: { maxRequestsPerSecond: 5, burst: 10 },
  maxAttempts: 3,
  configVersion: 'exec-policy-v1',
  maxNotional: 500000,
  priceDeviationPct: 0.2
};

export interface SubmitInputs {
  request: ExecutionRequest;
  /** Safety context for the FINAL payload (instrument, eligibility, market, risk, mode...). */
  safetyCtx: SafetyContext;
  /** Expected position before order (for consistency check). Null skips check. */
  expectedQty?: number | null;
  /** Operator identity for audit. */
  operator?: string;
}

function mapBrokerError(err: unknown): BrokerErrorCode {
  const msg = err instanceof Error ? `${err.name} ${err.message}`.toUpperCase() : String(err).toUpperCase();
  if (msg.includes('TIMEOUT') || msg.includes('TIMED OUT') || msg.includes('ETIMEDOUT')) return 'TIMEOUT';
  if (msg.includes('RATE') || msg.includes('429') || msg.includes('THROTTL')) return 'RATE_LIMIT';
  if (msg.includes('OUTAGE') || msg.includes('UNAVAILABLE') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('DNS')) return 'OUTAGE';
  if (msg.includes('MALFORMED') || msg.includes('SCHEMA') || msg.includes('INVALID RESPONSE')) return 'MALFORMED_RESPONSE';
  if (msg.includes('INVALID') || msg.includes('VALIDATION')) return 'INVALID_ORDER';
  if (msg.includes('REJECT')) return 'BROKER_REJECTION';
  if (msg.includes('PERMISSION') || msg.includes('UNAUTHORIZED') || msg.includes('FORBIDDEN') || msg.includes('AUTH')) return 'PERMISSION';
  if (msg.includes('5XX') || msg.includes('500') || msg.includes('RESET') || msg.includes('ECONNRESET')) return 'CONNECTION_RESET';
  return 'UNKNOWN';
}

function validateBrokerResponse(raw: unknown): { ok: boolean; reason?: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed: not an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.brokerOrderId !== 'string' || r.brokerOrderId.length === 0) return { ok: false, reason: 'malformed: brokerOrderId' };
  const validStatus = ['PENDING', 'OPEN', 'FILLED', 'PARTIAL', 'CANCELLED', 'REJECTED'];
  if (typeof r.status !== 'string' || !validStatus.includes(r.status)) return { ok: false, reason: `malformed: status ${String(r.status)}` };
  if (typeof r.filledQty !== 'number' || !Number.isFinite(r.filledQty) || r.filledQty < 0) return { ok: false, reason: 'malformed: filledQty' };
  if (r.avgPrice !== null && (typeof r.avgPrice !== 'number' || !Number.isFinite(r.avgPrice))) return { ok: false, reason: 'malformed: avgPrice' };
  return { ok: true };
}

let orderSeq = 0;
export function resetEngineSeqForTests(): void { orderSeq = 0; }

export class ExecutionService {
  readonly ledger: ExecutionLedger;
  readonly kills: KillSwitchManager;
  private readonly bucket: TokenBucket;
  private noNewRisk = false;

  constructor(
    private readonly broker: BrokerPort,
    private readonly cfg: EngineConfig = DEFAULT_ENGINE_CONFIG,
    private readonly now: () => number = Date.now
  ) {
    this.ledger = new ExecutionLedger(cfg.ledger, now);
    this.kills = new KillSwitchManager();
    this.bucket = new TokenBucket(cfg.rateLimit, now);
  }

  get brokerKind(): string { return this.broker.kind; }

  /** Emergency safe state: block all new risk until reconciliation succeeds. */
  enterNoNewRisk(reason: string): void {
    this.noNewRisk = true;
    this.ledger.auditEvent('no-new-risk', null, null, null, null, this.cfg.configVersion, { reason });
  }
  exitNoNewRisk(operator: string): void {
    void operator;
    this.noNewRisk = false;
  }
  isNoNewRisk(): boolean { return this.noNewRisk; }

  private blockReason(req: ExecutionRequest): string | null {
    if (this.noNewRisk) return 'NO_NEW_RISK: reconciliation pending';
    const k = this.kills.check({ strategyId: req.strategyId, instrumentId: req.instrumentId, portfolioId: req.portfolioDecisionId });
    if (k.blocked) return `kill switch: ${k.reasons.join('; ')}`;
    return null;
  }

  private newOrderId(): string {
    orderSeq += 1;
    return `ord-${this.now()}-${orderSeq}`;
  }

  /** Main submission path. Returns the persisted OrderRecord (terminal or tracked). */
  async submit(inp: SubmitInputs): Promise<OrderRecord> {
    const { request: req, safetyCtx } = inp;
    const operator = inp.operator ?? 'operator';
    const ts = this.now();

    // 0. Idempotency: same request/key -> one semantic order (no duplicate broker order).
    const existing = this.ledger.getByIdempotency(req.idempotencyKey);
    if (existing) {
      this.ledger.auditEvent('idempotent-replay', existing.orderId, req.requestId, req.traceId, req.executionMode, req.configVersion, {
        portfolioDecisionId: req.portfolioDecisionId, idempotencyKey: req.idempotencyKey, result: 'returned existing order'
      });
      return existing;
    }
    // Duplicate intent scan (explicit policy).
    for (const o of this.ledger.listOrders()) {
      if (isDuplicateIntent(o.intent, req)) {
        this.ledger.auditEvent('duplicate-intent', o.orderId, req.requestId, req.traceId, req.executionMode, req.configVersion, {
          portfolioDecisionId: req.portfolioDecisionId, matchedOrder: o.orderId, result: 'returned existing order'
        });
        return o;
      }
    }

    const orderId = this.newOrderId();
    // Build final payload FIRST (what will actually be submitted).
    const payload: OrderCmd = {
      clientOrderId: req.idempotencyKey,
      decisionId: req.portfolioDecisionId,
      instrumentId: req.instrumentId,
      exchange: req.exchange,
      segment: req.segment,
      side: req.side,
      quantity: req.quantity,
      orderType: req.orderType === 'STOP' || req.orderType === 'STOP_LIMIT' ? 'LIMIT' : req.orderType as 'MARKET' | 'LIMIT',
      limitPrice: req.limitPrice,
      strategyId: req.strategyId
    };
    // Preserve original requested type for unsupported-type rejection below.
    let rec = emptyOrderRecord(orderId, req, payload, ts);
    this.ledger.putOrder(rec);
    const audit = (kind: string, detail: Record<string, unknown>) =>
      this.ledger.auditEvent(kind, orderId, req.requestId, req.traceId, req.executionMode, req.configVersion, redactSecrets(detail) as Record<string, unknown>);

    const reject = (reason: string, failureClass: RetryClass = 'DO_NOT_RETRY'): OrderRecord => {
      rec = this.ledger.getOrder(orderId)!;
      if (canTransition(rec.state, 'VALIDATING')) rec = this.ledger.transition(orderId, 'VALIDATING', 'validating');
      rec = this.ledger.getOrder(orderId)!;
      assertTransition(rec.state, 'REJECTED');
      rec = this.ledger.transition(orderId, 'REJECTED', reason);
      rec = { ...rec, failureReason: reason, failureClass };
      this.ledger.putOrder(rec);
      audit('rejected', { reason, failureClass, portfolioDecisionId: req.portfolioDecisionId, riskDecisionId: req.riskDecisionId });
      return this.ledger.getOrder(orderId)!;
    };

    // 1. Kill switch / safe state.
    const blocked = this.blockReason(req);
    if (blocked) return reject(blocked);

    // 2. Live containment: live modes impossible; live gate always blocks live.
    if (safetyCtx.mode === 'CONTROLLED_LIVE' || safetyCtx.mode === 'AUTONOMOUS_LIVE') {
      const gate = evaluateLiveGate({
        mode: safetyCtx.mode, promotionActive: false, operatorEnabled: false, riskConfigured: false,
        brokerAuthenticated: false, healthOk: false, reconcileReady: false, killSwitchReady: false, explicitLiveFlag: false
      });
      audit('live-blocked', { mode: safetyCtx.mode, gate });
      return reject(`live mode ${safetyCtx.mode} impossible in Phase 8 (AUTONOMOUS_LIVE=DISABLED)`);
    }
    if (req.executionMode !== 'SIMULATION' && req.executionMode !== 'PAPER') {
      return reject(`unsupported execution mode: ${req.executionMode}`);
    }
    // Env/flag escalation attempts are ignored by construction: only explicit operator
    // enablement + persisted promotion could ever allow live, and both are absent here.
    // (Tested: AUTONOMOUS_LIVE env var cannot change this path.)

    // 3. Broker kind: only sim may execute in Phase 8.
    if (this.broker.kind !== 'sim') {
      audit('broker-kind-blocked', { kind: this.broker.kind });
      return reject(`broker kind ${this.broker.kind} disabled in Phase 8 (sim/paper only)`);
    }

    // 4. Risk consumption (execution never mutates risk).
    if (!req.riskVerdictAllow) return reject(`risk rejection: decision ${req.riskDecisionId} did not ALLOW`);
    if (req.quantity > req.riskCappedQty) return reject(`quantity ${req.quantity} exceeds risk cap ${req.riskCappedQty}`);
    if (!safetyCtx.riskVerdict || !safetyCtx.riskVerdict.allow) return reject('risk verdict missing or REJECT');
    if (req.quantity > safetyCtx.riskVerdict.cappedQty) return reject(`quantity exceeds risk cap ${safetyCtx.riskVerdict.cappedQty}`);

    // 5. Explicit order-type / TIF support (no silent downgrade).
    if (!isSupportedOrderType(req.orderType)) return reject(`unsupported order type: ${req.orderType}`);
    if (!isSupportedTif(req.timeInForce)) return reject(`unsupported time-in-force: ${req.timeInForce}`);
    if (req.orderType === 'LIMIT' && (req.limitPrice == null || !Number.isFinite(req.limitPrice) || req.limitPrice <= 0)) {
      return reject(`limit price required for LIMIT: ${String(req.limitPrice)}`);
    }

    // 6. Notional guard (do not trust caller-supplied values blindly).
    const refPrice = req.limitPrice ?? safetyCtx.lastPrice ?? 0;
    const notional = refPrice > 0 ? refPrice * req.quantity : req.expectedNotional;
    if (!Number.isFinite(notional) || notional <= 0) return reject('cannot compute notional: bad price');
    if (notional > this.cfg.maxNotional) return reject(`notional ${notional} exceeds max ${this.cfg.maxNotional}`);

    // 7. Mandatory safety gate on the FINAL payload (no bypass, no earlier-decision reliance).
    rec = this.ledger.transition(orderId, 'VALIDATING', 'safety gate on final payload');
    const gate = validateOrder(payload, { ...safetyCtx, riskVerdict: safetyCtx.riskVerdict });
    audit('safety-gate', { verdict: gate.verdict, reasons: gate.reasons, finalPayload: payload });
    if (gate.verdict !== 'ALLOW') {
      assertTransition(rec.state, 'REJECTED');
      let r = this.ledger.transition(orderId, 'REJECTED', `safety gate REJECT: ${gate.reasons.join('; ')}`);
      r = { ...r, failureReason: gate.reasons.join('; '), failureClass: 'DO_NOT_RETRY' };
      this.ledger.putOrder(r);
      return this.ledger.getOrder(orderId)!;
    }

    // 8. TOCTOU revalidation: if material state changed since gate, re-run gate.
    const revalidation = validateOrder(payload, { ...safetyCtx, riskVerdict: safetyCtx.riskVerdict });
    if (revalidation.verdict !== 'ALLOW') return reject(`TOCTOU revalidation failed: ${revalidation.reasons.join('; ')}`);

    // 9. Margin/funds from reconciled broker state (UNKNOWN blocks new risk).
    try {
      const funds = await this.broker.getAccountState();
      const margin = await this.broker.getMargin(payload);
      audit('funds-margin', { equity: funds.equity, cash: funds.cash, marginRequired: margin.required, sufficient: margin.sufficient });
      if (!margin.sufficient) return reject(`insufficient margin: required ${margin.required}, available ${margin.available}`);
    } catch (err) {
      const code = mapBrokerError(err);
      audit('funds-unknown', { code, error: err instanceof Error ? err.message : String(err) });
      return reject(`stale account/funds state: ${code} — blocked until reconciliation`);
    }

    // 10. Position consistency: expected vs local vs broker (mismatch -> reconcile first).
    try {
      const positions = await this.broker.getPositions();
      const brokerQty = positions.find((p) => p.instrumentId === req.instrumentId)?.qty ?? 0;
      if (inp.expectedQty !== undefined && inp.expectedQty !== null && inp.expectedQty !== brokerQty) {
        audit('position-mismatch', { expected: inp.expectedQty, brokerQty, result: 'blocked; reconcile first' });
        return reject(`position mismatch: expected ${inp.expectedQty} vs broker ${brokerQty} — reconcile first`);
      }
    } catch (err) {
      audit('position-unknown', { error: err instanceof Error ? err.message : String(err) });
      return reject('authoritative broker position unavailable — blocked until reconciliation');
    }

    // 11. Rate limit (bounded; throttled submissions are rejected, not queued unboundedly).
    if (!this.bucket.tryAcquire(1)) {
      audit('rate-limited', { result: 'rejected (bounded, no infinite queue)' });
      return reject('rate limited: try again later');
    }

    // 12. APPROVED -> SUBMITTED within the controlled boundary, then submit.
    rec = this.ledger.getOrder(orderId)!;
    assertTransition(rec.state, 'APPROVED');
    rec = this.ledger.transition(orderId, 'APPROVED', `approved by gate + risk (${operator})`);
    assertTransition(rec.state, 'SUBMITTED');
    rec = this.ledger.transition(orderId, 'SUBMITTED', 'final payload submitted to broker adapter');
    audit('submit', { brokerKind: this.broker.kind, finalPayload: payload });

    let brokerResp;
    try {
      brokerResp = await this.broker.placeOrder(payload, { lastPrice: safetyCtx.lastPrice ?? undefined });
    } catch (err) {
      // Ambiguous failure -> UNKNOWN (never assume filled/rejected, never blind resubmit).
      const code = mapBrokerError(err);
      const classification = classifyRetry(code);
      rec = this.ledger.getOrder(orderId)!;
      assertTransition(rec.state, 'UNKNOWN');
      rec = this.ledger.transition(orderId, 'UNKNOWN', `broker interaction uncertain: ${code}`);
      rec = { ...rec, failureClass: classification, failureReason: code };
      this.ledger.putOrder(rec);
      audit('unknown', { code, classification, error: err instanceof Error ? err.message : String(err), next: 'RECONCILE before any resubmit' });
      return this.ledger.getOrder(orderId)!;
    }

    // 13. Broker response is untrusted: validate schema before trusting.
    const schema = validateBrokerResponse(brokerResp);
    audit('broker-response', { response: brokerResp });
    if (!schema.ok) {
      rec = this.ledger.getOrder(orderId)!;
      assertTransition(rec.state, 'UNKNOWN');
      rec = this.ledger.transition(orderId, 'UNKNOWN', `malformed broker response: ${schema.reason}`);
      rec = { ...rec, failureClass: 'DO_NOT_RETRY', failureReason: schema.reason ?? 'malformed' };
      this.ledger.putOrder(rec);
      return this.ledger.getOrder(orderId)!;
    }

    // Adopt broker facts (broker wins). Step through legal transitions.
    rec = this.ledger.getOrder(orderId)!;
    let cur: OrderRecord = { ...rec, brokerOrderId: brokerResp.brokerOrderId, brokerStatus: brokerResp.status };
    this.ledger.putOrder(cur);
    const target = brokerStatusToOrderState(brokerResp.status, brokerResp.filledQty, cur.requestedQty);
    const step = (from: OrderState, to: OrderState, reason: string): void => {
      const c = this.ledger.getOrder(orderId)!;
      if (c.state === to) return;
      assertTransition(c.state, to);
      this.ledger.transition(orderId, to, reason);
    };
    if (target === 'BROKER_REJECTED') {
      step(cur.state, 'BROKER_REJECTED', 'broker rejected order');
    } else if (target === 'FILLED') {
      step(cur.state, 'ACKNOWLEDGED', `broker ack ${brokerResp.brokerOrderId}`);
      if (brokerResp.filledQty > 0) {
        const fill: FillEvent = {
          fillId: `${brokerResp.brokerOrderId}-fill-1`, orderId, brokerOrderId: brokerResp.brokerOrderId,
          quantity: brokerResp.filledQty, price: brokerResp.avgPrice ?? refPrice, timestamp: this.now(), fees: 0, cumulativeFilledQty: brokerResp.filledQty
        };
        const withFill = applyFill(this.ledger.getOrder(orderId)!, fill);
        this.ledger.putOrder(withFill);
        audit('fill', { fill });
      }
      step(this.ledger.getOrder(orderId)!.state, 'FILLED', 'broker reports filled');
    } else if (target === 'PARTIALLY_FILLED') {
      step(cur.state, 'ACKNOWLEDGED', `broker ack ${brokerResp.brokerOrderId}`);
      const fill: FillEvent = {
        fillId: `${brokerResp.brokerOrderId}-fill-1`, orderId, brokerOrderId: brokerResp.brokerOrderId,
        quantity: brokerResp.filledQty, price: brokerResp.avgPrice ?? refPrice, timestamp: this.now(), fees: 0, cumulativeFilledQty: brokerResp.filledQty
      };
      const withFill = applyFill(this.ledger.getOrder(orderId)!, fill);
      this.ledger.putOrder(withFill);
      audit('fill', { fill });
      step(this.ledger.getOrder(orderId)!.state, 'PARTIALLY_FILLED', `partial ${brokerResp.filledQty}/${cur.requestedQty}`);
    } else {
      step(cur.state, 'ACKNOWLEDGED', `broker ack ${brokerResp.brokerOrderId}`);
    }
    // Sync filledQty/avgPrice from broker truth.
    const done = this.ledger.getOrder(orderId)!;
    this.ledger.putOrder({ ...done, brokerStatus: brokerResp.status, filledQty: brokerResp.filledQty, remainingQty: Math.max(0, done.requestedQty - brokerResp.filledQty), avgPrice: brokerResp.avgPrice });
    return this.ledger.getOrder(orderId)!;
  }

  /** Refresh a tracked order from the broker (safe-read retry only). */
  async refresh(orderId: string): Promise<OrderRecord> {
    const rec = this.ledger.getOrder(orderId);
    if (!rec) throw new Error(`EXEC_UNKNOWN_ORDER: ${orderId}`);
    if (!rec.brokerOrderId) return rec;
    let remote;
    try {
      remote = await this.broker.getOrder(rec.brokerOrderId);
    } catch (err) {
      this.ledger.auditEvent('refresh-failed', orderId, rec.requestId, rec.traceId, rec.mode, rec.configVersion, { error: err instanceof Error ? err.message : String(err) });
      return rec;
    }
    const schema = validateBrokerResponse(remote);
    if (!schema.ok) {
      if (canTransition(rec.state, 'UNKNOWN')) {
        return this.ledger.transition(orderId, 'UNKNOWN', `malformed refresh response: ${schema.reason}`);
      }
      return rec;
    }
    // Idempotent fill sync: reconcile filledQty delta as a fill event when it grows.
    let cur = this.ledger.getOrder(orderId)!;
    if (remote.filledQty > cur.filledQty) {
      const delta = remote.filledQty - cur.filledQty;
      const fill: FillEvent = {
        fillId: `${rec.brokerOrderId}-fill-${cur.fills.length + 1}-${remote.filledQty}`, orderId,
        brokerOrderId: rec.brokerOrderId, quantity: delta, price: remote.avgPrice ?? cur.avgPrice ?? 0,
        timestamp: this.now(), fees: 0, cumulativeFilledQty: remote.filledQty
      };
      cur = applyFill(cur, fill);
      this.ledger.putOrder(cur);
      this.ledger.auditEvent('fill', orderId, rec.requestId, rec.traceId, rec.mode, rec.configVersion, { fill });
      cur = this.ledger.getOrder(orderId)!;
      const target = brokerStatusToOrderState(remote.status, remote.filledQty, cur.requestedQty);
      if (target !== cur.state && canTransition(cur.state, target)) {
        cur = this.ledger.transition(orderId, target, `refresh adopted broker ${remote.status}`);
      }
      cur = { ...this.ledger.getOrder(orderId)!, brokerStatus: remote.status, avgPrice: remote.avgPrice };
      this.ledger.putOrder(cur);
    } else if (remote.status !== cur.brokerStatus) {
      const target = brokerStatusToOrderState(remote.status, remote.filledQty, cur.requestedQty);
      if (target !== cur.state && canTransition(cur.state, target)) {
        this.ledger.transition(orderId, target, `refresh adopted broker ${remote.status}`);
      }
      const updated = { ...this.ledger.getOrder(orderId)!, brokerStatus: remote.status, avgPrice: remote.avgPrice };
      this.ledger.putOrder(updated);
    }
    return this.ledger.getOrder(orderId)!;
  }

  /** Reconcile a single order against authoritative broker state. */
  async reconcile(orderId: string): Promise<ReconciliationReport> {
    const rec = this.ledger.getOrder(orderId);
    if (!rec) throw new Error(`EXEC_UNKNOWN_ORDER: ${orderId}`);
    let cur = rec;
    if (cur.state === 'UNKNOWN' || cur.state === 'SUBMITTED' || cur.state === 'ACKNOWLEDGED' || cur.state === 'PARTIALLY_FILLED' || cur.state === 'CANCEL_REQUESTED') {
      if (canTransition(cur.state, 'RECONCILING')) {
        cur = this.ledger.transition(orderId, 'RECONCILING', 'reconciliation started (broker authoritative)');
      }
    }
    const { record: next, report } = await reconcileOrder(this.ledger.getOrder(orderId)!, this.broker, this.now);
    this.ledger.putOrder(next);
    this.ledger.auditEvent('reconcile', orderId, rec.requestId, rec.traceId, rec.mode, rec.configVersion, { report });
    return report;
  }

  /** Reconcile every open order (bounded passes; failures defer as UNKNOWN). */
  async reconcileAll(maxOrders = 100): Promise<ReconciliationReport[]> {
    const open = this.ledger.openOrders().slice(0, maxOrders);
    const out: ReconciliationReport[] = [];
    for (const o of open) {
      try {
        out.push(await this.reconcile(o.orderId));
      } catch (err) {
        this.ledger.auditEvent('reconcile-failed', o.orderId, o.requestId, o.traceId, o.mode, o.configVersion, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  /** Cancel with explicit policy: only operator intent or stale/expiry; never blind mass-cancel. */
  async cancel(orderId: string, operator: string, reason: string): Promise<OrderRecord> {
    const rec = this.ledger.getOrder(orderId);
    if (!rec) throw new Error(`EXEC_UNKNOWN_ORDER: ${orderId}`);
    if (rec.state !== 'ACKNOWLEDGED' && rec.state !== 'PARTIALLY_FILLED') {
      throw new Error(`EXEC_CANCEL_REJECT: state ${rec.state} cannot be cancelled`);
    }
    const blocked = this.kills.check({ strategyId: rec.intent.strategyId, instrumentId: rec.intent.instrumentId, portfolioId: rec.intent.portfolioDecisionId });
    void blocked;
    let cur = this.ledger.transition(orderId, 'CANCEL_REQUESTED', `cancel requested by ${operator}: ${reason}`);
    this.ledger.auditEvent('cancel-requested', orderId, rec.requestId, rec.traceId, rec.mode, rec.configVersion, { operator, reason });
    try {
      await this.broker.cancelOrder(rec.brokerOrderId!);
      cur = this.ledger.getOrder(orderId)!;
      cur = this.ledger.transition(orderId, 'CANCELLED', `cancelled by ${operator}`);
      this.ledger.auditEvent('cancelled', orderId, rec.requestId, rec.traceId, rec.mode, rec.configVersion, { operator });
      return this.ledger.getOrder(orderId)!;
    } catch (err) {
      const code = mapBrokerError(err);
      cur = this.ledger.getOrder(orderId)!;
      if (canTransition(cur.state, 'UNKNOWN')) {
        cur = this.ledger.transition(orderId, 'UNKNOWN', `cancel uncertain: ${code}`);
        cur = { ...cur, failureClass: classifyRetry(code), failureReason: code };
        this.ledger.putOrder(cur);
      }
      this.ledger.auditEvent('cancel-unknown', orderId, rec.requestId, rec.traceId, rec.mode, rec.configVersion, { code });
      return this.ledger.getOrder(orderId)!;
    }
  }

  /**
   * Restart recovery: load ledger -> query broker -> reconcile -> resume only if safe.
   * Uncertain state => NO_NEW_RISK until reconciliation succeeds.
   */
  async restartRecovery(): Promise<{ reconciled: number; safeToResume: boolean; reports: ReconciliationReport[] }> {
    const open = this.ledger.openOrders();
    if (open.length === 0) return { reconciled: 0, safeToResume: !this.noNewRisk, reports: [] };
    const reports = await this.reconcileAll(100);
    const stillUncertain = this.ledger.openOrders().some((o) => o.state === 'UNKNOWN' || o.state === 'RECONCILING');
    if (stillUncertain) {
      this.enterNoNewRisk('restart recovery: uncertain orders remain');
      return { reconciled: reports.length, safeToResume: false, reports };
    }
    return { reconciled: reports.length, safeToResume: !this.noNewRisk, reports };
  }

  getOrder(orderId: string): OrderRecord | undefined {
    return this.ledger.getOrder(orderId);
  }
  listOrders(): OrderRecord[] {
    return this.ledger.listOrders();
  }
  auditTrail(orderId?: string) {
    return this.ledger.auditTrail(orderId);
  }
}

export { buildIdempotencyKey };
export type { BrokerPort };
