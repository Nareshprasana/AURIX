// Deterministic cost, slippage, liquidity and calendar logic. All broker-neutral
// and config-driven; every assumption is recorded, never hidden.
import type { CostModel, LiquidityPolicy, SlippageModel } from './types.js';

export interface CostBreakdown {
  total: number;
  brokerage: number;
  exchange: number;
  taxes: number;
}

export function computeCost(notional: number, model: CostModel): CostBreakdown {
  const brokerage = (notional * model.brokerage_bps) / 10_000;
  const exchange = (notional * model.exchange_bps) / 10_000;
  const taxes = (notional * model.taxes_bps) / 10_000;
  const raw = brokerage + exchange + taxes;
  const total = Math.max(raw, model.min_cost);
  const scale = raw > 0 ? total / raw : 0;
  return { total, brokerage: brokerage * scale, exchange: exchange * scale, taxes: taxes * scale };
}

export interface SlippageResult {
  slippage_bps: number;
  assumed: string[];
}

/** Liquidity-aware slippage; unknown ADV degrades to base+spread with a recorded assumption. */
export function computeSlippage(
  orderValue: number,
  model: SlippageModel,
  market: { spread_bps: number | null; adv_value: number | null }
): SlippageResult {
  if (model.kind === 'fixed-bps') return { slippage_bps: model.base_bps, assumed: [] };
  const assumed: string[] = [];
  const spread = market.spread_bps ?? model.assumed_spread_bps ?? 0;
  if (market.spread_bps === null || market.spread_bps === undefined) {
    assumed.push(`spread assumed ${spread}bps (assumed_spread_bps)`);
  }
  let impact = 0;
  if (market.adv_value !== null && market.adv_value !== undefined && market.adv_value > 0) {
    impact = (model.impact_coeff ?? 0) * Math.sqrt(orderValue / market.adv_value) * 10_000;
  } else {
    assumed.push('adv unknown: impact term skipped (treated as illiquid-leaning base only)');
  }
  const share = model.spread_share ?? 0.5;
  return { slippage_bps: model.base_bps + share * (spread / 2) + impact, assumed };
}

export interface LiquidityCheck {
  ok: boolean;
  cappedQty: number;
  reasons: string[];
  unknown: boolean;
}

/** UNKNOWN liquidity never reads as LIQUID: entries block, exits pass capped. */
export function checkLiquidity(
  barValue: number,
  barVolume: number,
  advValue: number | null,
  spreadBps: number | null,
  qty: number,
  policy: LiquidityPolicy,
  isExit: boolean
): LiquidityCheck {
  const reasons: string[] = [];
  let unknown = false;
  let cappedQty = qty;
  if (barValue < policy.min_value) {
    reasons.push(`bar value ${barValue} < min ${policy.min_value}`);
  }
  if (barVolume < policy.min_volume) {
    reasons.push(`bar volume ${barVolume} < min ${policy.min_volume}`);
  }
  if (barVolume > 0) {
    const cap = Math.floor(barVolume * (Math.min(policy.max_participation, 100) / 100));
    if (cappedQty > cap) {
      cappedQty = Math.max(0, cap);
      reasons.push(`participation-capped to ${cappedQty}`);
    }
  }
  if (advValue === null || advValue === undefined) {
    unknown = true;
    reasons.push('UNKNOWN adv: cannot verify ADV share');
  }
  if (spreadBps === null || spreadBps === undefined) {
    unknown = true;
    reasons.push('UNKNOWN spread');
  }
  if (spreadBps !== null && spreadBps !== undefined && spreadBps > policy.max_spread_bps) {
    reasons.push(`spread ${spreadBps}bps > max ${policy.max_spread_bps}bps`);
  }
  const spreadFail = spreadBps !== null && spreadBps !== undefined && spreadBps > policy.max_spread_bps;
  const hardFail = barValue < policy.min_value || barVolume < policy.min_volume;
  if (isExit) {
    return { ok: cappedQty > 0, cappedQty, reasons, unknown };
  }
  // Entries may fill capped partials (recorded); hard failures and UNKNOWN block.
  const ok = !hardFail && !spreadFail && !unknown && cappedQty > 0;
  if (!ok && reasons.length === 0) reasons.push('liquidity gate');
  return { ok, cappedQty: ok ? cappedQty : 0, reasons, unknown };
}

// -- trading calendar (vendor-neutral sessions) ----------------------------------

export function dateStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class TradingCalendar {
  private sessions: string[];
  constructor(
    public readonly version: string,
    sessions: string[]
  ) {
    this.sessions = [...new Set(sessions)].sort();
  }
  static weekdays(from: string, to: string, holidays: string[] = [], version = 'cal-weekday-v1'): TradingCalendar {
    const out: string[] = [];
    const day = new Date(`${from}T00:00:00Z`).getTime();
    const end = new Date(`${to}T00:00:00Z`).getTime();
    const skip = new Set(holidays);
    for (let t = day; t <= end; t += 86_400_000) {
      const d = new Date(t);
      const dow = d.getUTCDay();
      const s = d.toISOString().slice(0, 10);
      if (dow !== 0 && dow !== 6 && !skip.has(s)) out.push(s);
    }
    return new TradingCalendar(version, out);
  }
  isSession(ts: number): boolean {
    return this.sessions.includes(dateStr(ts));
  }
  nextSession(ts: number): number | null {
    const d = dateStr(ts);
    const next = this.sessions.find((s) => s > d);
    return next ? Date.parse(`${next}T00:00:00Z`) : null;
  }
  sessionsBetween(fromTs: number, toTs: number): string[] {
    const a = dateStr(fromTs);
    const b = dateStr(toTs);
    return this.sessions.filter((s) => s >= a && s <= b);
  }
}
