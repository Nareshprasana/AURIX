// @aurix/execution-service — Risk ALLOW + SafetyGate ALLOW + sim-only + mode/promotion.
import type { OrderCmd, RiskVerdict, SafetyContext } from '@aurix/contracts';
import { validateOrder } from '@aurix/order-safety-gate';
import type { BrokerOrder, BrokerPort } from '@aurix/execution-interface';
import { Phase1DisabledError } from '@aurix/execution-interface';

export interface RouteRequest {
  cmd: OrderCmd;
  risk: RiskVerdict | null;
  safetyCtx: SafetyContext;
  broker: BrokerPort;
}

export async function routeOrder(req: RouteRequest): Promise<BrokerOrder> {
  // 0. Phase 1 hard gate: live modes are unreachable (no ACTIVE promotion can
  //    exist). Independent of the safety gate below — defense in depth.
  if (req.safetyCtx.mode === 'CONTROLLED_LIVE' || req.safetyCtx.mode === 'AUTONOMOUS_LIVE') {
    throw new Error(`EXEC_REJECT: live mode ${req.safetyCtx.mode} impossible in Phase 1`);
  }
  // 1. Risk required + ALLOW.
  if (!req.risk) throw new Error('EXEC_REJECT: missing risk verdict');
  if (!req.risk.allow) throw new Error(`EXEC_REJECT: risk verdict REJECT (${req.risk.reasons.join('; ')})`);
  // 2. Safety gate independent check.
  const gate = validateOrder(req.cmd, { ...req.safetyCtx, riskVerdict: req.risk });
  if (gate.verdict !== 'ALLOW') throw new Error(`EXEC_REJECT: safety gate REJECT (${gate.reasons.join('; ')})`);
  // 3. Phase 1: only sim broker kind may execute.
  if (req.broker.kind !== 'sim') throw new Phase1DisabledError(`execution-route:${req.broker.kind}`);
  return req.broker.placeOrder(req.cmd, { lastPrice: req.safetyCtx.lastPrice ?? undefined });
}
