// Vendor-neutral regime classification + strategy applicability.
import type { Applicability, RegimeSpec, RegimeState } from './types.js';
import { sma, stdevLogReturns } from './indicators.js';

export function classifyRegime(closes: number[], i: number, abnormal = false): RegimeState {
  const fast = sma(closes, 5, i);
  const slow = sma(closes, 20, i);
  let trend: RegimeState['trend'] = 'flat';
  if (fast !== null && slow !== null) {
    const gap = (fast - slow) / slow;
    trend = gap > 0.005 ? 'up' : gap < -0.005 ? 'down' : 'flat';
  }
  const vol = stdevLogReturns(closes, 20, i);
  const volatility = vol !== null && vol > 0.02 ? 'high' : 'low';
  return { trend, volatility, label: `${trend}_${volatility}`, abnormal };
}

export function checkApplicability(regimes: RegimeSpec, regime: RegimeState): { status: Applicability; reason: string } {
  if (regimes.blocked.includes('*')) {
    return { status: 'NOT_APPLICABLE', reason: 'all regimes blocked (*)' };
  }
  if (regime.abnormal && regimes.blocked.includes('abnormal')) {
    return { status: 'NOT_APPLICABLE', reason: `blocked abnormal regime (${regime.label})` };
  }
  if (regimes.blocked.includes(regime.label)) {
    return { status: 'NOT_APPLICABLE', reason: `regime ${regime.label} blocked` };
  }
  if (regimes.supported.length > 0 && !regimes.supported.includes(regime.label) && !regimes.supported.includes('*')) {
    return { status: 'NOT_APPLICABLE', reason: `regime ${regime.label} not supported` };
  }
  return { status: 'APPLICABLE', reason: `regime ${regime.label} applicable` };
}
