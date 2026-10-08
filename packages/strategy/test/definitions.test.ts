import { describe, expect, it } from 'vitest';
import { FAMILY_PRESETS, registerFamily, validateDefinition } from '../src/index.js';
import { makeDef } from './fixtures.js';

describe('strategy definitions', () => {
  it('accepts a valid definition', () => {
    expect(validateDefinition(makeDef())).toEqual([]);
  });

  it('rejects ambiguous definitions', () => {
    expect(validateDefinition(makeDef({ id: '' })).join(' ')).toMatch(/missing id/);
    expect(validateDefinition(makeDef({ scope: { markets: [], segments: [], timeframes: [], universe: [] } })).join(' ')).toMatch(/empty universe/);
    expect(validateDefinition(makeDef({ sizing: { type: 'fixed-qty', max_notional: 1, max_adv_pct: 5 } })).join(' ')).toMatch(/qty/);
    expect(validateDefinition(makeDef({ params: { fast: 500, slow: 20 }, param_bounds: { fast: [2, 50], slow: [5, 200] } })).join(' ')).toMatch(/outside/);
    expect(validateDefinition(makeDef({ cost_model: { brokerage_bps: -1, exchange_bps: 0, taxes_bps: 0, min_cost: 0, per_side: true } })).join(' ')).toMatch(/negative/);
  });

  it('rejects unknown operators and indicators', () => {
    const def = makeDef();
    (def.entry_long as { operator: string }).operator = 'moonshot';
    expect(validateDefinition(def).join(' ')).toMatch(/unknown operator/);
  });

  it('supports an extensible family interface', () => {
    registerFamily('test-rsi-like', {
      family: 'momentum',
      requiredParams: ['n'],
      bounds: { n: [2, 30] },
      build: (p) => ({
        entry_long: { left: { indicator: 'roc', params: { n: p['n']! } }, operator: 'above', right: { const: 0.01 } },
        entry_short: { left: { indicator: 'roc', params: { n: p['n']! } }, operator: 'below', right: { const: -0.01 } },
        exit: { left: { indicator: 'roc', params: { n: p['n']! } }, operator: 'below', right: { const: 0 } }
      })
    });
    expect(FAMILY_PRESETS['test-rsi-like']!.family).toBe('momentum');
    expect(() => registerFamily('test-rsi-like', FAMILY_PRESETS['test-rsi-like']!)).toThrow(/FAMILY_EXISTS/);
    expect(() => FAMILY_PRESETS['sma-cross']!.build({ fast: 50, slow: 20 })).toThrow(/fast must be/);
  });
});
