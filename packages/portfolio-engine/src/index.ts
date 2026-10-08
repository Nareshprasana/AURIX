// @aurix/portfolio-engine — deterministic exposure math skeleton (Phase 1).
export interface PositionInput {
  instrumentId: string;
  sector: string;
  notional: number;
}

export interface ExposureReport {
  grossExposurePct: number;
  sectorExposurePct: Record<string, number>;
}

export function computeExposure(equity: number, positions: PositionInput[]): ExposureReport {
  if (equity <= 0) return { grossExposurePct: 0, sectorExposurePct: {} };
  let gross = 0;
  const bySector: Record<string, number> = {};
  for (const p of positions) {
    gross += Math.abs(p.notional);
    bySector[p.sector] = (bySector[p.sector] ?? 0) + Math.abs(p.notional);
  }
  const pct = (n: number) => (n / equity) * 100;
  const sectorExposurePct: Record<string, number> = {};
  for (const [s, n] of Object.entries(bySector)) sectorExposurePct[s] = pct(n);
  return { grossExposurePct: pct(gross), sectorExposurePct };
}
