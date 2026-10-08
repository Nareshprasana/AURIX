// @aurix/execution-service — reconciliation (Phase 8 §23, §24).
// Broker state wins for broker-owned facts; local intent/history preserved.

import {
  assertTransition,
  brokerStatusToOrderState,
  type BrokerPort,
  type OrderRecord,
  type ReconcileDiscrepancy,
  type ReconciliationReport
} from '@aurix/execution-interface';

export async function reconcileOrder(
  record: OrderRecord,
  broker: BrokerPort,
  now: () => number = Date.now
): Promise<{ record: OrderRecord; report: ReconciliationReport }> {
  const ts = now();
  const discrepancies: ReconcileDiscrepancy[] = [];
  if (!record.brokerOrderId) {
    const report: ReconciliationReport = {
      orderId: record.orderId,
      localBefore: record.state,
      brokerStatus: null,
      brokerFilledQty: null,
      discrepancies: [{
        kind: 'MISSING_ORDER', orderId: record.orderId, before: record.state,
        after: 'UNKNOWN', source: 'local', timestamp: ts, result: 'no broker order id; deferred'
      }],
      localAfter: record.state,
      timestamp: ts,
      result: 'DEFERRED_UNKNOWN'
    };
    return { record, report };
  }
  let brokerState;
  try {
    brokerState = await broker.getOrder(record.brokerOrderId);
  } catch (err) {
    const report: ReconciliationReport = {
      orderId: record.orderId,
      localBefore: record.state,
      brokerStatus: null,
      brokerFilledQty: null,
      discrepancies: [{
        kind: 'STALE_BROKER', orderId: record.orderId, before: record.state,
        after: record.state, source: 'broker', timestamp: ts,
        result: `broker query failed: ${err instanceof Error ? err.message : String(err)}`
      }],
      localAfter: record.state,
      timestamp: ts,
      result: 'DEFERRED_UNKNOWN'
    };
    return { record, report };
  }

  const authoritative = brokerStatusToOrderState(brokerState.status, brokerState.filledQty, record.requestedQty);
  if (brokerState.filledQty !== record.filledQty) {
    discrepancies.push({
      kind: brokerState.filledQty > record.filledQty ? 'PARTIAL_FILL' : 'STALE_LOCAL',
      orderId: record.orderId,
      before: `local-filled=${record.filledQty}`,
      after: `broker-filled=${brokerState.filledQty}`,
      source: 'broker',
      timestamp: ts,
      result: 'adopted broker filledQty'
    });
  }
  if (mapStateForCompare(record.state) !== mapStateForCompare(authoritative)) {
    discrepancies.push({
      kind: 'STALE_LOCAL',
      orderId: record.orderId,
      before: record.state,
      after: authoritative,
      source: 'broker',
      timestamp: ts,
      result: 'adopted broker state for broker-owned facts'
    });
  }

  if (discrepancies.length === 0) {
    return {
      record,
      report: {
        orderId: record.orderId, localBefore: record.state, brokerStatus: brokerState.status,
        brokerFilledQty: brokerState.filledQty, discrepancies, localAfter: record.state,
        timestamp: ts, result: 'NO_DIFF'
      }
    };
  }

  // Adopt broker facts: filledQty/avgPrice/brokerStatus. Local intent + history preserved.
  const filledQty = brokerState.filledQty;
  const remainingQty = Math.max(0, record.requestedQty - filledQty);
  let next = {
    ...record,
    brokerStatus: brokerState.status,
    filledQty,
    remainingQty,
    avgPrice: brokerState.avgPrice,
    lastReconciledAt: ts,
    updatedAt: ts
  };
  // Move through RECONCILING -> RECONCILED only when legal; otherwise adopt minimal legal path.
  // From any non-terminal uncertain state we first enter RECONCILING (if legal), then RECONCILED.
  try {
    if (next.state === 'UNKNOWN' || next.state === 'SUBMITTED' || next.state === 'ACKNOWLEDGED' || next.state === 'PARTIALLY_FILLED' || next.state === 'CANCEL_REQUESTED') {
      assertTransition(next.state, 'RECONCILING');
      next = { ...next, state: 'RECONCILING', history: [...next.history, { from: record.state, to: 'RECONCILING' as const, timestamp: ts, reason: 'reconcile: broker authoritative' }] };
      assertTransition('RECONCILING', 'RECONCILED');
      next = { ...next, state: 'RECONCILED', history: [...next.history, { from: 'RECONCILING' as const, to: 'RECONCILED' as const, timestamp: ts, reason: `adopted broker ${brokerState.status} filled=${filledQty}` }] };
    } else if (next.state === 'RECONCILING') {
      assertTransition('RECONCILING', 'RECONCILED');
      next = { ...next, state: 'RECONCILED', history: [...next.history, { from: 'RECONCILING' as const, to: 'RECONCILED' as const, timestamp: ts, reason: `adopted broker ${brokerState.status}` }] };
    }
    // Terminal local states (FILLED/CANCELLED/etc.) keep their state but record reconciliation
    // in history via audit; broker divergence is preserved as discrepancy evidence.
  } catch {
    // If transition illegal (e.g. already terminal), keep local state; discrepancies preserved.
  }

  return {
    record: next,
    report: {
      orderId: record.orderId, localBefore: record.state, brokerStatus: brokerState.status,
      brokerFilledQty: brokerState.filledQty, discrepancies, localAfter: next.state,
      timestamp: ts, result: 'ADOPTED_BROKER'
    }
  };
}

function mapStateForCompare(s: string): string {
  if (s === 'RECONCILED' || s === 'RECONCILING') return s;
  return s;
}
