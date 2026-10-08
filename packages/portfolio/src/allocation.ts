// Deterministic allocators. Every method is a pure function of declared inputs
// with bounded outputs and an explanation trail. No LLM weight input exists.
import type { AllocationMethod, AllocationResult, PortfolioCandidate } from './types.js';

function capWeights(
  weights: Record<string, number>,
  maxWeightPct: number
): { weights: Record<string, number>; capped: AllocationResult['capped'] } {
  const capped: AllocationResult['capped'] = [];
  const out: Record<string, number> = {};
  for (const [id, w] of Object.entries(weights)) {
    if (w > maxWeightPct) {
      capped.push({ instrument_id: id, requested: w, capped: maxWeightPct, reason: `max position weight ${maxWeightPct}%` });
      out[id] = maxWeightPct;
    } else {
      out[id] = w;
    }
  }
  return { weights: out, capped };
}

function normalize(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  if (total <= 0) return Object.fromEntries(Object.keys(weights).map((k) => [k, 0]));
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, (v / total) * 100]));
}

function keyOf(c: PortfolioCandidate): string {
  return c.instrument.instrument_id;
}

export function allocateEqual(candidates: PortfolioCandidate[], maxWeightPct = 2): AllocationResult {
  const explanation = [`equal weight 1/${candidates.length || 1} (bounded)`];
  if (candidates.length === 0) return { method: 'equal', weights: {}, capped: [], explanation };
  const each = 100 / candidates.length;
  const weights: Record<string, number> = {};
  for (const c of candidates) weights[keyOf(c)] = each;
  const { weights: out, capped } = capWeights(weights, maxWeightPct);
  return { method: 'equal', weights: out, capped, explanation };
}

export function allocateSignal(candidates: PortfolioCandidate[], maxWeightPct = 2): AllocationResult {
  const explanation = ['signal-weighted on normalized strength (bounded)'];
  if (candidates.length === 0) return { method: 'signal', weights: {}, capped: [], explanation };
  const total = candidates.reduce((s, c) => s + Math.max(0, c.signal_strength), 0);
  const weights: Record<string, number> = {};
  for (const c of candidates) {
    weights[keyOf(c)] = total > 0 ? (Math.max(0, c.signal_strength) / total) * 100 : 100 / candidates.length;
  }
  const { weights: out, capped } = capWeights(weights, maxWeightPct);
  return { method: 'signal', weights: out, capped, explanation };
}

export function allocateInverseVol(candidates: PortfolioCandidate[], volatilities: Record<string, number>, maxWeightPct = 2, method: AllocationResult['method'] = 'risk'): AllocationResult {
  const explanation = [`${method}: inverse-volatility weights (bounded; zero/unknown vol capped)`];
  if (candidates.length === 0) return { method, weights: {}, capped: [], explanation };
  const inv: Record<string, number> = {};
  for (const c of candidates) {
    const v = volatilities[keyOf(c)];
    inv[keyOf(c)] = v !== undefined && v > 0 ? 1 / v : 0;
  }
  const weights = normalize(inv);
  if (Object.values(weights).every((w) => w === 0) && candidates.length > 0) {
    return allocateEqual(candidates, maxWeightPct);
  }
  const { weights: out, capped } = capWeights(weights, maxWeightPct);
  return { method, weights: out, capped, explanation };
}

export function allocateConfidence(candidates: PortfolioCandidate[], maxWeightPct = 2): AllocationResult {
  const explanation = ['confidence-weighted on validated confidence (bounded; NOT a probability)'];
  if (candidates.length === 0) return { method: 'confidence', weights: {}, capped: [], explanation };
  const weights: Record<string, number> = {};
  for (const c of candidates) weights[keyOf(c)] = Math.max(0, Math.min(1, c.signal_confidence)) * 100;
  const normed = normalize(weights);
  const finalWeights = Object.values(normed).every((w) => w === 0) ? Object.fromEntries(candidates.map((c) => [keyOf(c), 100 / candidates.length])) : normed;
  const { weights: out, capped } = capWeights(finalWeights, maxWeightPct);
  return { method: 'confidence', weights: out, capped, explanation };
}

export function allocateHybrid(
  candidates: PortfolioCandidate[],
  inputs: { volatilities?: Record<string, number>; liquidityScores?: Record<string, number> } = {},
  maxWeightPct = 2,
  mix: { signal: number; volatility: number; confidence: number; liquidity: number } = { signal: 0.4, volatility: 0.3, confidence: 0.2, liquidity: 0.1 }
): AllocationResult {
  const explanation = [`hybrid signal/volatility/confidence/liquidity mix ${mix.signal}/${mix.volatility}/${mix.confidence}/${mix.liquidity} (bounded)`];
  if (candidates.length === 0) return { method: 'hybrid', weights: {}, capped: [], explanation };
  const vols = inputs.volatilities ?? {};
  const liq = inputs.liquidityScores ?? {};
  const norm = (vals: Record<string, number>): Record<string, number> => {
    const total = Object.values(vals).reduce((s, v) => s + Math.max(0, v), 0);
    if (total <= 0) return Object.fromEntries(candidates.map((c) => [keyOf(c), 1 / candidates.length]));
    return Object.fromEntries(candidates.map((c) => [keyOf(c), Math.max(0, vals[keyOf(c)] ?? 0) / total]));
  };
  const sSig = norm(Object.fromEntries(candidates.map((c) => [keyOf(c), c.signal_strength])));
  const sVol = norm(Object.fromEntries(candidates.map((c) => {
    const v = vols[keyOf(c)];
    return [keyOf(c), v !== undefined && v > 0 ? 1 / v : 0];
  })));
  const sConf = norm(Object.fromEntries(candidates.map((c) => [keyOf(c), c.signal_confidence])));
  const sLiq = norm(Object.fromEntries(candidates.map((c) => [keyOf(c), liq[keyOf(c)] ?? 0.5])));
  const weights: Record<string, number> = {};
  for (const c of candidates) {
    const id = keyOf(c);
    weights[id] = (mix.signal * sSig[id]! + mix.volatility * sVol[id]! + mix.confidence * sConf[id]! + mix.liquidity * sLiq[id]!) * 100;
  }
  const { weights: out, capped } = capWeights(weights, maxWeightPct);
  return { method: 'hybrid', weights: out, capped, explanation };
}

export interface AllocationInputs {
  volatilities?: Record<string, number>;
  maxWeightPct?: number;
  hybridWeights?: { signal: number; volatility: number; confidence: number; liquidity: number };
  liquidityScores?: Record<string, number>;
}

export const ALLOCATORS: Record<AllocationMethod, (candidates: PortfolioCandidate[], inputs?: AllocationInputs) => AllocationResult> = {
  equal: (candidates, inputs) => allocateEqual(candidates, inputs?.maxWeightPct),
  signal: (candidates, inputs) => allocateSignal(candidates, inputs?.maxWeightPct),
  risk: (candidates, inputs) => allocateInverseVol(candidates, inputs?.volatilities ?? {}, inputs?.maxWeightPct, 'risk'),
  volatility: (candidates, inputs) => allocateInverseVol(candidates, inputs?.volatilities ?? {}, inputs?.maxWeightPct, 'volatility'),
  confidence: (candidates, inputs) => allocateConfidence(candidates, inputs?.maxWeightPct),
  hybrid: (candidates, inputs) => allocateHybrid(candidates, { volatilities: inputs?.volatilities, liquidityScores: inputs?.liquidityScores }, inputs?.maxWeightPct, inputs?.hybridWeights as { signal: number; volatility: number; confidence: number; liquidity: number } | undefined)
};
