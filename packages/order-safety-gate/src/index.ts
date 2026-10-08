// @aurix/order-safety-gate — deterministic pre-execution validation (Amendment 3).
// ALLOW/REJECT + reasons. LLM can never override; REJECT never reaches broker.
import type { OrderCmd, SafetyContext, SafetyVerdict } from '@aurix/contracts';

function hasSeen(seen: Set<string> | string[], key: string): boolean {
  if (seen instanceof Set) return seen.has(key);
  return seen.includes(key);
}

export function validateOrder(cmd: OrderCmd, ctx: SafetyContext): SafetyVerdict {
  const reasons: string[] = [];
  const reject = (r: string) => reasons.push(r);

  // 1. instrument identity
  if (!ctx.instrument) reject('unknown instrument');
  else {
    if (ctx.instrument.id !== cmd.instrumentId) reject('wrong symbol: cmd/instrument mismatch');
    if (ctx.instrument.exchange !== cmd.exchange) reject('wrong exchange');
    if (ctx.instrument.segment !== cmd.segment) reject('wrong segment');
  }
  // 2. eligibility (UNKNOWN fail-closed)
  if (ctx.eligibility !== 'LEGAL') reject(`eligibility not LEGAL: ${ctx.eligibility}`);
  // 3. market status
  if (ctx.marketStatus !== 'OPEN') reject(`market not OPEN: ${ctx.marketStatus}`);
  // 4. side / type
  if (cmd.side !== 'BUY' && cmd.side !== 'SELL') reject(`invalid side: ${cmd.side}`);
  if (cmd.orderType !== 'MARKET' && cmd.orderType !== 'LIMIT') reject(`invalid order type: ${cmd.orderType}`);
  // 5. quantity
  if (!Number.isFinite(cmd.quantity) || cmd.quantity <= 0) reject(`invalid quantity: ${cmd.quantity}`);
  if (cmd.quantity > ctx.brokerMaxQty) reject(`oversized quantity: ${cmd.quantity} > max ${ctx.brokerMaxQty}`);
  if (ctx.instrument && cmd.quantity % ctx.instrument.lot_size !== 0) {
    reject(`invalid lot size: qty ${cmd.quantity} not multiple of ${ctx.instrument.lot_size}`);
  }
  // 6. price / tick
  if (cmd.orderType === 'LIMIT') {
    if (cmd.limitPrice == null || !Number.isFinite(cmd.limitPrice) || cmd.limitPrice <= 0) {
      reject(`invalid limit price: ${cmd.limitPrice}`);
    } else if (ctx.instrument) {
      const tick = ctx.instrument.tick_size;
      const steps = cmd.limitPrice / tick;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) reject(`invalid tick size: price ${cmd.limitPrice} not multiple of ${tick}`);
      if (ctx.lastPrice != null && Math.abs(cmd.limitPrice - ctx.lastPrice) / ctx.lastPrice > 0.2) {
        reject(`stale price: limit ${cmd.limitPrice} vs last ${ctx.lastPrice}`);
      }
    }
  }
  // 7. notional sanity
  const refPrice = cmd.limitPrice ?? ctx.lastPrice ?? 0;
  if (refPrice <= 0 && cmd.orderType === 'LIMIT') reject('cannot compute notional: bad price');
  // 8. duplicate / idempotency
  if (!cmd.clientOrderId) reject('missing idempotency key');
  else if (hasSeen(ctx.seenIdempotencyKeys, cmd.clientOrderId)) reject(`duplicate order: ${cmd.clientOrderId}`);
  // 9. staleness
  if (ctx.nowTs - ctx.decisionTs > ctx.decisionTtlS * 1000) reject('stale decision');
  if (ctx.nowTs - ctx.marketDataTs > ctx.marketDataStalenessS * 1000) reject('stale market data');
  // 10. risk state + verdict
  if (ctx.riskHalted) reject('risk state invalid: halt active');
  if (!ctx.riskVerdict) reject('missing risk verdict');
  else if (!ctx.riskVerdict.allow) reject('risk verdict REJECT');
  else if (cmd.quantity > ctx.riskVerdict.cappedQty) reject(`quantity exceeds risk cap ${ctx.riskVerdict.cappedQty}`);
  // 11. strategy authorization
  if (!ctx.strategyAuthorized) reject('strategy not authorized');
  // 12. mode + promotion
  if (ctx.mode !== 'PAPER' && ctx.mode !== 'SHADOW') {
    // Phase 1: only non-live research modes exist; live requires ACTIVE promotion (impossible in Phase 1).
    if (ctx.mode === 'RESEARCH' || ctx.mode === 'BACKTEST') reject(`wrong mode for orders: ${ctx.mode}`);
    else if (!ctx.promotionActive) reject(`mode ${ctx.mode} without ACTIVE promotion`);
  }

  if (reasons.length === 0) return { verdict: 'ALLOW', reasons: ['safety gate ALLOW'] };
  return { verdict: 'REJECT', reasons };
}
