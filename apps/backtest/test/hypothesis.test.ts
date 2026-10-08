import { describe, expect, it } from 'vitest';
import { buildHypothesis, buildStrategyFromHypothesis, describeWithInterpreter } from '../src/index.js';

const SCOPE = { markets: ['equity'], segments: ['EQ'], timeframes: ['1D'], universe: ['X'] };
const MODELS = {
  cost_model: { brokerage_bps: 5, exchange_bps: 2, taxes_bps: 3, min_cost: 0, per_side: true },
  slippage_model: { kind: 'fixed-bps' as const, base_bps: 5 },
  liquidity: { min_value: 1, min_volume: 1, max_participation: 100, max_adv_pct: 100, max_spread_bps: 10000 },
  regimes: { supported: [] as string[], preferred: [] as string[], blocked: [] as string[] }
};

function hypothesisInput(over: Record<string, unknown> = {}) {
  return {
    research_inputs: ['research:1'],
    observations: ['momentum persists'],
    mechanism: 'winners keep winning over short horizons',
    target_regime: 'trending',
    expected_signal: 'LONG on strength',
    expected_behavior: 'continuation',
    falsification: 'no excess return over 60 sessions',
    ...over
  };
}

describe('hypothesis layer', () => {
  it('validates required fields and stays deterministic', () => {
    expect(() => buildHypothesis({ ...hypothesisInput(), mechanism: '' })).toThrow(/HYPOTHESIS_MISSING_FIELD/);
    expect(() => buildHypothesis({ ...hypothesisInput(), observations: [] })).toThrow(/HYPOTHESIS_MISSING_FIELD/);
    const a = buildHypothesis(hypothesisInput());
    const b = buildHypothesis(hypothesisInput());
    expect(a.hypothesis_id).toBe(b.hypothesis_id);
  });

  it('builds strategies only from structured validated input', () => {
    const hyp = buildHypothesis(hypothesisInput());
    const def = buildStrategyFromHypothesis({
      id: 'test:roc', name: 'roc', familyPreset: 'roc-momentum', family: 'momentum',
      scope: SCOPE, params: { n: 5, threshold: 0.01 },
      sizing: { type: 'fixed-qty', qty: 10, max_notional: 100000, max_adv_pct: 5 },
      ...MODELS, hypothesis: hyp
    });
    expect(def.family_preset).toBe('roc-momentum');
    expect(def.status).toBe('HYPOTHESIS');
    expect(def.params).toEqual({ n: 5, threshold: 0.01 });
  });

  it('rejects out-of-bounds params and unknown presets (no silent misbuild)', () => {
    const hyp = buildHypothesis(hypothesisInput());
    const base = {
      id: 'test:roc', name: 'roc', familyPreset: 'roc-momentum', family: 'momentum' as const,
      scope: SCOPE,
      sizing: { type: 'fixed-qty' as const, qty: 10, max_notional: 100000, max_adv_pct: 5 },
      ...MODELS, hypothesis: hyp
    };
    expect(() => buildStrategyFromHypothesis({ ...base, params: { n: 500, threshold: 0.01 } })).toThrow(/PARAM_OUT_OF_BOUNDS/);
    expect(() => buildStrategyFromHypothesis({ ...base, params: { n: 5, threshold: 0.01 }, familyPreset: 'nope' })).toThrow(/UNKNOWN_FAMILY_PRESET/);
    expect(() => buildStrategyFromHypothesis({ ...base, params: { n: 5, threshold: 0.01 }, familyPreset: 'sma-cross', family: 'momentum' as const })).toThrow(/FAMILY_MISMATCH/);
  });

  it('LLM wording stays wording: structure comes from validated inputs', async () => {
    const hyp = buildHypothesis(hypothesisInput());
    const r = await describeWithInterpreter({ interpret: async () => ({ text: 'fancy words', model: 'stub' }) }, hyp);
    expect(r).toEqual({ text: 'fancy words', model: 'stub' });
    const def = buildStrategyFromHypothesis({
      id: 'test:roc', name: 'roc', familyPreset: 'roc-momentum', family: 'momentum',
      scope: SCOPE, params: { n: 5, threshold: 0.01 },
      sizing: { type: 'fixed-qty', qty: 10, max_notional: 100000, max_adv_pct: 5 },
      ...MODELS, hypothesis: hyp
    });
    expect(def.entry_long.operator).toBe('above'); // from preset, not from LLM text
  });
});
