// Hypothetical rebalance engine (intents only, never orders), turnover control,
// mark-to-market, snapshots and reproducible portfolio decisions.
import type {
  PortfolioDecision,
  PortfolioState,
  PositionView,
  RebalanceIntent,
  RebalanceLine
} from './types.js';
import type { CostModel } from '@aurix/strategy';
import { computeCost } from '@aurix/strategy';
import { computeExposure } from './capital.js';

export interface RebalanceInput {
  current: PositionView[];
  targets: Record<string, number>;
  prices: Record<string, number>;
  turnoverBudgetPct: number;
  equity: number;
  cost_model: CostModel;
}

export function diffRebalance(input: RebalanceInput): { lines: RebalanceLine[]; turnover_pct: number; estimated_cost: number } {
  const ids = new Set([...input.current.map((p) => p.instrument_id), ...Object.keys(input.targets)]);
  const current = new Map(input.current.map((p) => [p.instrument_id, p.qty]));
  const lines: RebalanceLine[] = [];
  for (const id of [...ids].sort()) {
    const cur = current.get(id) ?? 0;
    const tgt = input.targets[id] ?? 0;
    const delta = tgt - cur;
    let intent: RebalanceIntent;
    if (delta === 0) intent = cur === 0 ? 'NO_CHANGE' : 'HOLD';
    else if (cur === 0 && tgt > 0) intent = 'BUY';
    else if (cur === 0 && tgt < 0) intent = 'SELL';
    else if (tgt === 0) intent = 'REDUCE';
    else if (delta > 0) intent = 'INCREASE';
    else intent = 'REDUCE';
    const price = input.prices[id] ?? 0;
    const estCost = price > 0 ? computeCost(Math.abs(delta) * price, input.cost_model).total : 0;
    lines.push({ instrument_id: id, current_qty: cur, target_qty: tgt, delta_qty: delta, intent, est_cost: estCost, reason: delta === 0 ? 'no change' : `target ${tgt} vs current ${cur}` });
  }
  const turnover = lines.reduce((s, l) => s + Math.abs(l.delta_qty) * (input.prices[l.instrument_id] ?? 0), 0);
  const turnoverPct = input.equity > 0 ? (turnover / input.equity) * 100 : 0;
  return { lines, turnover_pct: turnoverPct, estimated_cost: lines.reduce((s, l) => s + l.est_cost, 0) };
}

/** Turnover budget: largest-delta-first cutoff; the rest stay NO_CHANGE with reason. */
export function applyTurnoverBudget(
  lines: RebalanceLine[],
  prices: Record<string, number>,
  equity: number,
  budgetPct: number
): { lines: RebalanceLine[]; turnover_pct: number; deferred: string[] } {
  const movers = lines.filter((l) => l.delta_qty !== 0).sort((a, b) => Math.abs(b.delta_qty) * (prices[b.instrument_id] ?? 0) - Math.abs(a.delta_qty) * (prices[a.instrument_id] ?? 0));
  const kept: RebalanceLine[] = [];
  const deferred: string[] = [];
  let used = 0;
  const budget = (equity * budgetPct) / 100;
  for (const line of movers) {
    const value = Math.abs(line.delta_qty) * (prices[line.instrument_id] ?? 0);
    if (used + value <= budget) {
      used += value;
      kept.push(line);
    } else {
      deferred.push(line.instrument_id);
    }
  }
  const finalLines = lines.map((l) => {
    if (l.delta_qty === 0 || kept.some((k) => k.instrument_id === l.instrument_id)) return l;
    return { ...l, target_qty: l.current_qty, delta_qty: 0, intent: 'NO_CHANGE' as RebalanceIntent, est_cost: 0, reason: `deferred by turnover budget ${budgetPct}%` };
  });
  const turnoverPct = equity > 0 ? (used / equity) * 100 : 0;
  return { lines: finalLines, turnover_pct: turnoverPct, deferred };
}

export interface MarkResult {
  positions: PositionView[];
  realized_pnl: number;
  unrealized_pnl: number;
  daily_pnl_pct: number;
  drawdown_pct: number;
  peak_equity: number;
}

/** Deterministic mark-to-market with price provenance carried on positions. */
export function markToMarket(
  positions: PositionView[],
  prices: Record<string, number>,
  prevEquity: number,
  peakEquity: number,
  equity: number
): MarkResult {
  let unrealized = 0;
  const marked = positions.map((p) => {
    const mark = prices[p.instrument_id] ?? p.mark_price;
    const upnl = p.side === 0 ? 0 : (mark - p.avg_price) * p.qty * p.side;
    unrealized += upnl;
    return { ...p, mark_price: mark, market_value: mark * p.qty, unrealized_pnl: upnl };
  });
  const realized = positions.reduce((s, p) => s + p.realized_pnl, 0);
  const daily = prevEquity > 0 ? ((equity - prevEquity) / prevEquity) * 100 : 0;
  const peak = Math.max(peakEquity, equity);
  const drawdown = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
  return { positions: marked, realized_pnl: realized, unrealized_pnl: unrealized, daily_pnl_pct: daily, drawdown_pct: drawdown, peak_equity: peak };
}

export function summarizeDecision(input: {
  decision_id: string;
  timestamp: number;
  portfolio_id: string;
  portfolio_version: number;
  candidates: string[];
  proposed: Record<string, number>;
  approved: Record<string, number>;
  reduced: PortfolioDecision['reduced'];
  rejected: PortfolioDecision['rejected'];
  risk_decisions: PortfolioDecision['risk_decisions'];
  positions: PositionView[];
  equity: number;
  expected_turnover: number;
  estimated_costs: number;
  assumptions: string[];
  evidence_refs: string[];
  versions: Record<string, string>;
}): PortfolioDecision {
  const exposure = computeExposure(input.positions, input.equity);
  const finalOutcome = Object.keys(input.approved).length === 0
    ? (input.rejected.length > 0 ? 'RISK_BLOCKED' as const : 'NO_TRADE' as const)
    : 'TRADE' as const;
  return {
    decision_id: input.decision_id,
    timestamp: input.timestamp,
    portfolio_id: input.portfolio_id,
    portfolio_version: input.portfolio_version,
    candidates: [...input.candidates],
    proposed: { ...input.proposed },
    approved: { ...input.approved },
    reduced: input.reduced.map((r) => ({ ...r })),
    rejected: input.rejected.map((r) => ({ ...r })),
    risk_decisions: [...input.risk_decisions],
    exposure: { gross_pct: exposure.gross_pct, net_pct: exposure.net_pct, long_pct: exposure.long_pct, short_pct: exposure.short_pct },
    expected_turnover: input.expected_turnover,
    estimated_costs: input.estimated_costs,
    assumptions: [...input.assumptions],
    evidence_refs: [...input.evidence_refs],
    versions: { ...input.versions },
    outcome: finalOutcome
  };
}

export function buildSnapshot(state: PortfolioState): PortfolioState {
  return JSON.parse(JSON.stringify(state)) as PortfolioState;
}
