// @aurix/system-health — skeleton checks → safe-mode signal (Phase 1).
export interface HealthSnapshot {
  modelAvailable: boolean;
  marketDataStale: boolean;
  brokerUnstable: boolean;
  riskHalted: boolean;
  stateCorrupt: boolean;
}

export function toSafeMode(h: HealthSnapshot): { safeMode: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (h.marketDataStale) reasons.push('market data stale: no new trades');
  if (h.brokerUnstable) reasons.push('broker unstable: no new trades');
  if (h.riskHalted) reasons.push('risk limits breached: no new trades');
  if (!h.modelAvailable) reasons.push('model unavailable: no new AI trades');
  if (h.stateCorrupt) reasons.push('corrupted state: reconcile before trading');
  return { safeMode: reasons.length > 0, reasons };
}
