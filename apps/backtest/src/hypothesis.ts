// Hypothesis layer: structured hypotheses from research, validated builders to
// strategy definitions. LLM text may supply wording only; required fields and
// parameter bounds are enforced deterministically. No codegen, ever.
import type { StrategyDefinition, StrategyFamily, StrategyHypothesis } from '@aurix/strategy';
import { FAMILY_PRESETS, validateDefinition } from '@aurix/strategy';
import { cyrb53hex, stableStringify } from '@aurix/knowledge-service';

export interface HypothesisInput {
  research_inputs: string[];
  observations: string[];
  mechanism: string;
  target_regime: string;
  expected_signal: string;
  expected_behavior: string;
  falsification: string;
  assumptions?: string[];
  evidence?: string[];
  confidence?: number;
  source?: string;
  author?: string;
  now?: number;
}

export function buildHypothesis(input: HypothesisInput): StrategyHypothesis {
  for (const f of ['mechanism', 'target_regime', 'expected_signal', 'expected_behavior', 'falsification'] as const) {
    if (!input[f] || input[f].trim().length === 0) throw new Error(`HYPOTHESIS_MISSING_FIELD: ${f}`);
  }
  if (input.observations.length === 0) throw new Error('HYPOTHESIS_MISSING_FIELD: observations');
  const confidence = input.confidence ?? 0.5;
  if (!(confidence >= 0 && confidence <= 1)) throw new Error('HYPOTHESIS_BAD_CONFIDENCE');
  const now = input.now ?? Date.now();
  const id = `hyp-${cyrb53hex(stableStringify([input.mechanism, input.target_regime, input.expected_signal])).slice(0, 12)}`;
  return {
    hypothesis_id: id,
    research_inputs: [...input.research_inputs],
    observations: [...input.observations],
    mechanism: input.mechanism,
    target_regime: input.target_regime,
    expected_signal: input.expected_signal,
    expected_behavior: input.expected_behavior,
    falsification: input.falsification,
    assumptions: [...(input.assumptions ?? [])],
    evidence: [...(input.evidence ?? [])],
    confidence,
    provenance: { source: input.source ?? 'strategy-lab', source_type: 'agent', evidence_refs: [...input.evidence ?? []] },
    created_at: now,
    author: input.author ?? 'strategy-lab'
  };
}

export interface StrategyBuildInput {
  id: string;
  name: string;
  description?: string;
  familyPreset: string;
  family: StrategyFamily;
  scope: StrategyDefinition['scope'];
  params: Record<string, number>;
  sizing: StrategyDefinition['sizing'];
  signal_horizon_bars?: number;
  required_observations?: string[];
  required_data?: string[];
  required_events?: string[];
  assumptions?: string[];
  cost_model: StrategyDefinition['cost_model'];
  slippage_model: StrategyDefinition['slippage_model'];
  liquidity: StrategyDefinition['liquidity'];
  regimes: StrategyDefinition['regimes'];
  hypothesis: StrategyHypothesis;
  author?: string;
  parent?: { id: string; version: number };
  now?: number;
}

/** Deterministic construction: same hypothesis + params → same definition. */
export function buildStrategyFromHypothesis(input: StrategyBuildInput): StrategyDefinition {
  const preset = FAMILY_PRESETS[input.familyPreset];
  if (!preset) throw new Error(`UNKNOWN_FAMILY_PRESET: ${input.familyPreset}`);
  if (preset.family !== input.family) throw new Error(`FAMILY_MISMATCH: preset ${input.familyPreset} is ${preset.family}`);
  const conditions = preset.build(input.params);
  for (const [k, b] of Object.entries(preset.bounds)) {
    const v = input.params[k];
    if (v === undefined) throw new Error(`PARAM_MISSING: ${k}`);
    if (v < b[0] || v > b[1]) throw new Error(`PARAM_OUT_OF_BOUNDS: ${k}=${v} not in [${b[0]},${b[1]}]`);
  }
  const def: StrategyDefinition = {
    id: input.id,
    version: 1,
    name: input.name,
    description: input.description ?? input.hypothesis.mechanism,
    family: input.family,
    scope: input.scope,
    entry_long: conditions.entry_long,
    entry_short: conditions.entry_short,
    exit: conditions.exit,
    sizing: input.sizing,
    signal_horizon_bars: input.signal_horizon_bars ?? 5,
    required_observations: input.required_observations ?? [],
    required_data: input.required_data ?? [],
    required_events: input.required_events ?? [],
    assumptions: [...(input.assumptions ?? []), ...input.hypothesis.assumptions],
    cost_model: input.cost_model,
    slippage_model: input.slippage_model,
    liquidity: input.liquidity,
    regimes: input.regimes,
    params: { ...input.params },
    param_bounds: { ...preset.bounds },
    family_preset: input.familyPreset,
    created_at: input.now ?? Date.now(),
    author: input.author ?? 'strategy-lab',
    provenance: { source: 'strategy-lab', source_type: 'agent', evidence_refs: [input.hypothesis.hypothesis_id, ...input.hypothesis.evidence] },
    evidence_refs: [input.hypothesis.hypothesis_id, ...input.hypothesis.evidence],
    status: 'HYPOTHESIS',
    ...(input.parent ? { parent: input.parent } : {})
  };
  const errors = validateDefinition(def);
  if (errors.length > 0) throw new Error(`INVALID_STRATEGY: ${errors.join('; ')}`);
  return def;
}

export interface InterpreterLike {
  interpret(prompt: string, input: string): Promise<{ text: string; model: string }>;
}

/** LLM-assisted wording only: the returned text fills description fields; all
 * structural fields still come from validated inputs. Never code. */
export async function describeWithInterpreter(
  interpreter: InterpreterLike,
  hypothesis: StrategyHypothesis
): Promise<{ text: string; model: string }> {
  const r = await interpreter.interpret('strategy-description', hypothesis.mechanism);
  return { text: r.text.slice(0, 500), model: r.model };
}
