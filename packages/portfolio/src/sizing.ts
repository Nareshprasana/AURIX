// Deterministic position sizing. Each method declares explicit inputs, bounded
// outputs and an explanation. Final quantity is the minimum across applicable
// methods and risk caps — risk always wins. No LLM sizing exists.
import type { SizingMethod, SizingResult } from './types.js';

export interface SizingInputs {
  instrument_id: string;
  weight_pct: number;
  equity: number;
  price: number;
  volatility?: number | null;
  adv_value?: number | null;
  max_loss_pct?: number;
  stop_distance_pct?: number;
  target_vol_pct?: number;
  risk_budget_pct?: number;
  max_qty?: number;
}

function base(instrument_id: string, method: SizingMethod): { method: SizingMethod; instrument_id: string; inputs: Record<string, number> } {
  return { method, instrument_id, inputs: {} };
}

export function sizeFixedFraction(input: SizingInputs, fraction_pct: number): SizingResult {
  if (!(fraction_pct > 0)) throw new Error('SIZING_INVALID: fraction_pct must be > 0');
  const notional = (input.equity * fraction_pct) / 100;
  const qty = input.price > 0 ? Math.floor(notional / input.price) : 0;
  return {
    ...base(input.instrument_id, 'fixed-fraction'),
    qty: Math.max(0, qty),
    notional: qty * input.price,
    inputs: { weight_pct: input.weight_pct, fraction_pct, equity: input.equity, price: input.price },
    capped_by: [],
    explanation: `fixed ${fraction_pct}% of equity → ${qty} @ ${input.price}`
  };
}

export function sizeVolatilityTarget(input: SizingInputs, targetVolPct?: number): SizingResult {
  const target = targetVolPct ?? input.target_vol_pct ?? 1;
  const vol = input.volatility;
  if (vol === undefined || vol === null || !(vol > 0)) {
    return {
      ...base(input.instrument_id, 'volatility-target'),
      qty: 0, notional: 0,
      inputs: { target_vol_pct: target, equity: input.equity },
      capped_by: ['volatility-unknown'],
      explanation: 'volatility unknown: sized to zero (fail-safe)'
    };
  }
  const notional = (input.equity * (target / 100)) / vol;
  const qty = input.price > 0 ? Math.floor(notional / input.price) : 0;
  return {
    ...base(input.instrument_id, 'volatility-target'),
    qty: Math.max(0, qty),
    notional: qty * input.price,
    inputs: { target_vol_pct: target, volatility: vol, equity: input.equity, price: input.price },
    capped_by: [],
    explanation: `vol-target ${target}% / vol ${(vol * 100).toFixed(1)}% → ${qty}`
  };
}

export function sizeRiskBudget(input: SizingInputs, budgetPct?: number, stopPct?: number): SizingResult {
  const budget = budgetPct ?? input.risk_budget_pct ?? 0.5;
  const stop = stopPct ?? input.stop_distance_pct ?? 5;
  if (!(stop > 0) || !(input.price > 0)) {
    return {
      ...base(input.instrument_id, 'risk-budget'),
      qty: 0, notional: 0,
      inputs: { budget_pct: budget, stop_pct: stop },
      capped_by: ['invalid-stop'],
      explanation: 'invalid stop distance: sized to zero'
    };
  }
  const riskCapital = (input.equity * budget) / 100;
  const qty = Math.floor(riskCapital / (input.price * (stop / 100)));
  return {
    ...base(input.instrument_id, 'risk-budget'),
    qty: Math.max(0, qty),
    notional: qty * input.price,
    inputs: { budget_pct: budget, stop_pct: stop, equity: input.equity, price: input.price },
    capped_by: [],
    explanation: `risk ${budget}% with ${stop}% stop → ${qty}`
  };
}

export function sizeMaxLoss(input: SizingInputs, maxLossPct?: number, stopPct?: number): SizingResult {
  return sizeRiskBudget(input, maxLossPct ?? 1, stopPct);
}

export function sizeLiquidityConstrained(input: SizingInputs, advPct = 5): SizingResult {
  const adv = input.adv_value;
  if (adv === null || adv === undefined || !(adv > 0)) {
    return {
      ...base(input.instrument_id, 'liquidity-constrained'),
      qty: 0, notional: 0,
      inputs: { adv_pct: advPct },
      capped_by: ['adv-unknown'],
      explanation: 'ADV unknown: sized to zero (never assume liquid)'
    };
  }
  const notional = adv * (advPct / 100);
  const qty = input.price > 0 ? Math.floor(notional / input.price) : 0;
  return {
    ...base(input.instrument_id, 'liquidity-constrained'),
    qty: Math.max(0, qty),
    notional: qty * input.price,
    inputs: { adv_pct: advPct, adv_value: adv, price: input.price },
    capped_by: ['adv-cap'],
    explanation: `ADV-capped ${advPct}% → ${qty}`
  };
}

/** Final size = minimum across methods and caps (risk always wins). */
export function finalizeSize(results: SizingResult[], riskApprovedNotional: number, price: number): SizingResult {
  const qtys = results.map((r) => r.qty);
  const minQty = Math.min(...qtys);
  const riskQty = price > 0 ? Math.floor(riskApprovedNotional / price) : 0;
  const qty = Math.max(0, Math.min(minQty, riskQty));
  const binding = results.length > 0 && minQty <= riskQty ? 'sizing-methods' : 'risk-cap';
  return {
    method: results[0]?.method ?? 'fixed-fraction',
    instrument_id: results[0]?.instrument_id ?? '',
    qty,
    notional: qty * price,
    inputs: { methods: results.length, risk_approved_notional: riskApprovedNotional, price },
    capped_by: [binding],
    explanation: `final ${qty} (binding: ${binding})`
  };
}
