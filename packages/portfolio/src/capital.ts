// Deterministic capital model + exposure mathematics. Nothing here assumes
// full deployability: reserved capital and locked margin are always honored.
import type { CapitalProfile, CapitalState, PositionView } from './types.js';

export function buildCapital(profile: CapitalProfile, invested: number, marginUsed: number): CapitalState {
  if (!(profile.total > 0)) throw new Error('CAPITAL_INVALID: total must be > 0');
  const reserved = (profile.total * profile.reserved_pct) / 100;
  const cash = Math.max(0, profile.total - reserved - invested);
  const available = Math.max(0, cash - marginUsed);
  return {
    total: profile.total,
    cash,
    invested,
    available,
    reserved,
    margin_used: marginUsed,
    free_margin: available,
    gross_exposure: 0,
    net_exposure: 0
  };
}

export interface Exposure {
  gross: number;
  net: number;
  long: number;
  short: number;
  gross_pct: number;
  net_pct: number;
  long_pct: number;
  short_pct: number;
}

export function computeExposure(positions: PositionView[], equity: number): Exposure {
  let long = 0;
  let short = 0;
  for (const p of positions) {
    const mv = p.market_value;
    if (p.side === 1) long += Math.abs(mv);
    else if (p.side === -1) short += Math.abs(mv);
  }
  const gross = long + short;
  const net = long - short;
  const pct = (v: number) => (equity > 0 ? (v / equity) * 100 : 0);
  return { gross, net, long, short, gross_pct: pct(gross), net_pct: pct(net), long_pct: pct(long), short_pct: pct(short) };
}

/** Top-N share of gross exposure + HHI concentration index. */
export function concentration(positions: PositionView[]): { top1_pct: number; top5_pct: number; top10_pct: number; hhi: number } {
  const weights = positions
    .map((p) => Math.abs(p.market_value))
    .sort((a, b) => b - a);
  const total = weights.reduce((s, v) => s + v, 0);
  if (total <= 0) return { top1_pct: 0, top5_pct: 0, top10_pct: 0, hhi: 0 };
  const share = (n: number) => (weights.slice(0, n).reduce((s, v) => s + v, 0) / total) * 100;
  const hhi = weights.reduce((s, v) => s + (v / total) ** 2, 0);
  return { top1_pct: share(1), top5_pct: share(5), top10_pct: share(10), hhi };
}

/** Sector exposure from knowledge entity ids; unknown bucketed, never zeroed. */
export function sectorExposure(
  positions: PositionView[],
  sectors: Record<string, string | null>
): { bySector: Record<string, number>; unknown_pct: number; unknownIds: string[] } {
  const bySector: Record<string, number> = {};
  const unknownIds: string[] = [];
  const total = positions.reduce((s, p) => s + Math.abs(p.market_value), 0);
  for (const p of positions) {
    const sector = sectors[p.instrument_id] ?? p.sector ?? null;
    if (!sector) {
      unknownIds.push(p.instrument_id);
      continue;
    }
    bySector[sector] = (bySector[sector] ?? 0) + Math.abs(p.market_value);
  }
  const unknownValue = unknownIds.reduce((s, id) => {
    const p = positions.find((x) => x.instrument_id === id);
    return s + (p ? Math.abs(p.market_value) : 0);
  }, 0);
  return { bySector, unknown_pct: total > 0 ? (unknownValue / total) * 100 : 0, unknownIds };
}

export interface CorrelationView {
  matrix: Record<string, Record<string, number | null>>;
  /** Cluster exposure: summed |weight| of pairs with |rho| >= threshold. */
  clusterExposure(weights: Record<string, number>, threshold?: number): { pair: string; rho: number; combined_pct: number }[];
  unknownPairs: [string, string][];
}

export function correlationView(matrix: Record<string, Record<string, number | null>>): CorrelationView {
  const unknownPairs: [string, string][] = [];
  const ids = Object.keys(matrix).sort();
  for (const a of ids) {
    for (const b of ids) {
      if (a >= b) continue;
      const rho = matrix[a]?.[b] ?? matrix[b]?.[a] ?? null;
      if (rho === null || rho === undefined || !Number.isFinite(rho)) unknownPairs.push([a, b]);
    }
  }
  return {
    matrix,
    clusterExposure(weights: Record<string, number>, threshold = 0.7) {
      const out: { pair: string; rho: number; combined_pct: number }[] = [];
      for (const a of ids) {
        for (const b of ids) {
          if (a >= b) continue;
          const rho = matrix[a]?.[b] ?? matrix[b]?.[a] ?? null;
          if (rho !== null && rho !== undefined && Math.abs(rho) >= threshold) {
            out.push({ pair: `${a}|${b}`, rho, combined_pct: Math.abs(weights[a] ?? 0) + Math.abs(weights[b] ?? 0) });
          }
        }
      }
      return out.sort((x, y) => y.combined_pct - x.combined_pct);
    },
    unknownPairs
  };
}
