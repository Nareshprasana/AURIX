// Deterministic signal generation over one instrument's bar series.
// Signals at bar i use data <= i only. Regime-blocked strategies emit NO_SIGNAL
// (status NOT_APPLICABLE) instead of forcing a view.
import type {
  Applicability,
  RegimeState,
  Signal,
  SignalType,
  StrategyDefinition
} from './types.js';
import { evaluateCondition } from './families.js';
import { checkApplicability, classifyRegime } from './regime.js';

export interface SignalBatch {
  status: Applicability;
  reason: string;
  regime: RegimeState;
  signals: Signal[];
}

export function generateSignals(
  def: StrategyDefinition,
  instrumentId: string,
  closes: number[],
  timestamps: number[],
  dataVersion: string,
  generatedAt: number,
  abnormal = false
): SignalBatch {
  const regime = classifyRegime(closes, closes.length - 1, abnormal);
  const app = checkApplicability(def.regimes, regime);
  const base = {
    strategy_id: def.id,
    strategy_version: def.version,
    instrument_id: instrumentId,
    strength: 0.5,
    horizon_bars: def.signal_horizon_bars,
    data_version: dataVersion,
    params: { ...def.params },
    evidence: [...def.evidence_refs],
    confidence: 0.5,
    regime: regime.label,
    generated_at: generatedAt
  };
  if (app.status === 'NOT_APPLICABLE') {
    return { status: 'NOT_APPLICABLE', reason: app.reason, regime, signals: [] };
  }
  const signals: Signal[] = [];
  let position: 1 | -1 | 0 = 0;
  for (let i = 0; i < closes.length; i++) {
    const entryLong = evaluateCondition(def.entry_long, closes, i);
    const entryShort = evaluateCondition(def.entry_short, closes, i);
    const exit = evaluateCondition(def.exit, closes, i);
    let type: SignalType = 'HOLD';
    let note: string | undefined;
    if (entryLong === null || entryShort === null || exit === null) {
      type = 'NO_SIGNAL';
      note = 'indicator warmup';
    } else if (position === 1 && (exit || entryShort)) {
      type = 'EXIT';
      position = 0;
    } else if (position === -1 && (exit || entryLong)) {
      type = 'EXIT';
      position = 0;
    } else if (position === 0 && entryLong) {
      type = 'LONG';
      position = 1;
    } else if (position === 0 && entryShort) {
      type = 'SHORT';
      position = -1;
    }
    signals.push({
      ...base,
      ts: timestamps[i]!,
      type,
      direction: type === 'LONG' ? 1 : type === 'SHORT' ? -1 : 0,
      ref_price: closes[i]!,
      observations: [`${def.family} signal at bar ${i}`],
      ...(note ? { note } : {})
    });
  }
  return { status: 'APPLICABLE', reason: app.reason, regime, signals };
}
