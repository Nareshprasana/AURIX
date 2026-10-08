// Declarative strategy families. Conditions are data evaluated by a fixed
// operator set — no arbitrary code. Indicator reads use index <= i only.
import type {
  ConditionOperator,
  IndicatorRef,
  StrategyCondition,
  StrategyDefinition,
  StrategyFamily
} from './types.js';
import { donchian, roc, sma, stdevLogReturns, zscore } from './indicators.js';

export function evaluateIndicator(
  ref: IndicatorRef | { const: number },
  closes: number[],
  i: number
): number | null {
  if ('const' in ref) return ref.const;
  const n = ref.params?.['n'];
  switch (ref.indicator) {
    case 'price': return closes[i] ?? null;
    case 'sma': return n === undefined ? null : sma(closes, n, i);
    case 'roc': return n === undefined ? null : roc(closes, n, i);
    case 'stdev': return n === undefined ? null : stdevLogReturns(closes, n, i);
    case 'zscore': return n === undefined ? null : zscore(closes, n, i);
    case 'donchian_high': {
      if (n === undefined) return null;
      const lag = ref.params?.['lag'] ?? 0;
      const d = donchian(closes, n, i - lag);
      return d ? d.high : null;
    }
    case 'donchian_low': {
      if (n === undefined) return null;
      const lag = ref.params?.['lag'] ?? 0;
      const d = donchian(closes, n, i - lag);
      return d ? d.low : null;
    }
  }
}

export function evaluateCondition(
  cond: StrategyCondition,
  closes: number[],
  i: number
): boolean | null {
  const left = evaluateIndicator(cond.left, closes, i);
  const right = evaluateIndicator(cond.right, closes, i);
  if (left === null || right === null || !Number.isFinite(left) || !Number.isFinite(right)) return null;
  switch (cond.operator as ConditionOperator) {
    case 'above': return left > right;
    case 'below': return left < right;
    case 'crosses_above': {
      if (i <= 0) return null;
      const pl = evaluateIndicator(cond.left, closes, i - 1);
      const pr = evaluateIndicator(cond.right, closes, i - 1);
      if (pl === null || pr === null) return null;
      return pl <= pr && left > right;
    }
    case 'crosses_below': {
      if (i <= 0) return null;
      const pl = evaluateIndicator(cond.left, closes, i - 1);
      const pr = evaluateIndicator(cond.right, closes, i - 1);
      if (pl === null || pr === null) return null;
      return pl >= pr && left < right;
    }
  }
}

export interface FamilyPreset {
  family: StrategyFamily;
  requiredParams: string[];
  bounds: Record<string, [number, number]>;
  build(entry: Record<string, number>): { entry_long: StrategyCondition; entry_short: StrategyCondition; exit: StrategyCondition };
}

function num(params: Record<string, number>, key: string): number {
  const v = params[key];
  if (v === undefined || !Number.isFinite(v)) throw new Error(`FAMILY_PARAM_MISSING: ${key}`);
  return v;
}

export const FAMILY_PRESETS: Record<string, FamilyPreset> = {
  'sma-cross': {
    family: 'trend',
    requiredParams: ['fast', 'slow'],
    bounds: { fast: [2, 50], slow: [5, 200] },
    build: (p) => {
      const fast = num(p, 'fast');
      const slow = num(p, 'slow');
      if (!(fast < slow)) throw new Error('FAMILY_PARAM_INVALID: fast must be < slow');
      return {
        entry_long: { left: { indicator: 'sma', params: { n: fast } }, operator: 'crosses_above', right: { indicator: 'sma', params: { n: slow } } },
        entry_short: { left: { indicator: 'sma', params: { n: fast } }, operator: 'crosses_below', right: { indicator: 'sma', params: { n: slow } } },
        exit: { left: { indicator: 'price' }, operator: 'below', right: { indicator: 'sma', params: { n: fast } } }
      };
    }
  },
  'donchian-breakout': {
    family: 'breakout',
    requiredParams: ['n'],
    bounds: { n: [5, 100] },
    build: (p) => {
      const n = num(p, 'n');
      return {
        entry_long: { left: { indicator: 'price' }, operator: 'above', right: { indicator: 'donchian_high', params: { n, lag: 1 } } },
        entry_short: { left: { indicator: 'price' }, operator: 'below', right: { indicator: 'donchian_low', params: { n, lag: 1 } } },
        exit: { left: { indicator: 'price' }, operator: 'below', right: { indicator: 'donchian_low', params: { n, lag: 1 } } }
      };
    }
  },
  'zscore-meanreversion': {
    family: 'mean-reversion',
    requiredParams: ['n', 'entry_z', 'exit_z'],
    bounds: { n: [5, 100], entry_z: [0.5, 4], exit_z: [0, 2] },
    build: (p) => {
      const n = num(p, 'n');
      const entryZ = num(p, 'entry_z');
      const exitZ = num(p, 'exit_z');
      return {
        entry_long: { left: { indicator: 'zscore', params: { n } }, operator: 'below', right: { const: -entryZ } },
        entry_short: { left: { indicator: 'zscore', params: { n } }, operator: 'above', right: { const: entryZ } },
        exit: { left: { indicator: 'zscore', params: { n } }, operator: 'above', right: { const: -exitZ } }
      };
    }
  },
  'roc-momentum': {
    family: 'momentum',
    requiredParams: ['n', 'threshold'],
    bounds: { n: [2, 60], threshold: [0, 0.5] },
    build: (p) => {
      const n = num(p, 'n');
      const t = num(p, 'threshold');
      return {
        entry_long: { left: { indicator: 'roc', params: { n } }, operator: 'above', right: { const: t } },
        entry_short: { left: { indicator: 'roc', params: { n } }, operator: 'below', right: { const: -t } },
        exit: { left: { indicator: 'roc', params: { n } }, operator: 'below', right: { const: 0 } }
      };
    }
  },
  'event-reaction': {
    family: 'event',
    requiredParams: ['n', 'threshold', 'direction'],
    bounds: { n: [1, 20], threshold: [0, 0.5], direction: [1, 1] },
    build: (p) => {
      const n = num(p, 'n');
      const t = num(p, 'threshold');
      void num(p, 'direction');
      return {
        entry_long: { left: { indicator: 'roc', params: { n } }, operator: 'above', right: { const: t } },
        entry_short: { left: { indicator: 'roc', params: { n } }, operator: 'below', right: { const: -t } },
        exit: { left: { indicator: 'roc', params: { n } }, operator: 'below', right: { const: 0 } }
      };
    }
  }
};

export function registerFamily(name: string, preset: FamilyPreset): void {
  if (FAMILY_PRESETS[name]) throw new Error(`FAMILY_EXISTS: ${name}`);
  FAMILY_PRESETS[name] = preset;
}

const KNOWN_INDICATORS = ['price', 'sma', 'roc', 'stdev', 'zscore', 'donchian_high', 'donchian_low'];
const KNOWN_OPERATORS: ConditionOperator[] = ['crosses_above', 'crosses_below', 'above', 'below'];

function checkCondition(c: StrategyCondition, where: string, errors: string[]): void {
  if (!c || typeof c !== 'object') {
    errors.push(`${where}: not an object`);
    return;
  }
  for (const side of ['left', 'right'] as const) {
    const ref = c[side] as IndicatorRef | { const: number } | undefined;
    if (!ref || typeof ref !== 'object') {
      errors.push(`${where}.${side}: missing`);
      continue;
    }
    if ('const' in ref) {
      if (!Number.isFinite(ref.const)) errors.push(`${where}.${side}: bad const`);
    } else {
      if (!KNOWN_INDICATORS.includes(ref.indicator)) errors.push(`${where}.${side}: unknown indicator ${ref.indicator}`);
      if (ref.indicator !== 'price' && (ref.params?.['n'] === undefined || !(ref.params['n']! > 0))) {
        errors.push(`${where}.${side}: indicator ${ref.indicator} needs positive n`);
      }
    }
  }
  if (!KNOWN_OPERATORS.includes(c.operator)) errors.push(`${where}: unknown operator ${c.operator}`);
}

/** Structural validation of a strategy definition. Empty = valid. */
export function validateDefinition(def: StrategyDefinition): string[] {
  const errors: string[] = [];
  if (!def.id) errors.push('missing id');
  if (!def.name) errors.push('missing name');
  if (!FAMILY_PRESETS[def.id.split(':')[0] ?? ''] && !Object.values(FAMILY_PRESETS).some((p) => p.family === def.family)) {
    errors.push(`unknown family ${def.family}`);
  }
  if (!def.scope || def.scope.universe.length === 0) errors.push('empty universe');
  checkCondition(def.entry_long, 'entry_long', errors);
  checkCondition(def.entry_short, 'entry_short', errors);
  checkCondition(def.exit, 'exit', errors);
  const s = def.sizing;
  if (s.type !== 'fixed-qty' && s.type !== 'fixed-notional') errors.push('bad sizing type');
  if (s.type === 'fixed-qty' && !((s.qty ?? 0) > 0)) errors.push('fixed-qty needs qty > 0');
  if (s.type === 'fixed-notional' && !((s.notional ?? 0) > 0)) errors.push('fixed-notional needs notional > 0');
  if (!(s.max_notional > 0)) errors.push('max_notional must be > 0');
  if (!(s.max_adv_pct > 0 && s.max_adv_pct <= 100)) errors.push('max_adv_pct must be in (0,100]');
  if (def.cost_model.brokerage_bps < 0 || def.cost_model.exchange_bps < 0 || def.cost_model.taxes_bps < 0 || def.cost_model.min_cost < 0) {
    errors.push('cost model has negative component');
  }
  if (def.slippage_model.base_bps < 0) errors.push('slippage base_bps negative');
  if (def.liquidity.min_value < 0 || def.liquidity.min_volume < 0) errors.push('liquidity minimums negative');
  for (const [k, b] of Object.entries(def.param_bounds)) {
    const v = def.params[k];
    if (v === undefined) errors.push(`param ${k} missing value`);
    else if (v < b[0] || v > b[1]) errors.push(`param ${k}=${v} outside [${b[0]},${b[1]}]`);
  }
  return errors;
}
