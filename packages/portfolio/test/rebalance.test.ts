import { describe, expect, it } from 'vitest';
import { applyTurnoverBudget, buildSnapshot, diffRebalance, markToMarket, summarizeDecision } from '../src/index.js';
import { pos } from './helpers.js';

const COST = { brokerage_bps: 5, exchange_bps: 2, taxes_bps: 3, min_cost: 0, per_side: true };

describe('rebalance intents', () => {
  it('emits BUY/SELL/INCREASE/REDUCE/HOLD/NO_CHANGE correctly', () => {
    const current = [pos('A', 10_000), pos('B', -5_000)];
    const { lines } = diffRebalance({
      current, targets: { A: 100, B: 0, C: 50 }, prices: { A: 100, B: 100, C: 100 },
      turnoverBudgetPct: 100, equity: 1_000_000, cost_model: COST
    });
    const byId = Object.fromEntries(lines.map((l) => [l.instrument_id, l]));
    expect(byId['A']?.intent).toBe('HOLD'); // 100 == 100
    expect(byId['B']?.intent).toBe('REDUCE'); // to zero from short
    expect(byId['C']?.intent).toBe('BUY');
    expect(lines.every((l) => l.est_cost >= 0)).toBe(true);
  });

  it('INCREASE vs HOLD vs NO_CHANGE', () => {
    const current = [pos('A', 10_000)];
    const { lines } = diffRebalance({
      current, targets: { A: 200, B: 0 }, prices: { A: 100, B: 100 },
      turnoverBudgetPct: 100, equity: 1_000_000, cost_model: COST
    });
    expect(lines.find((l) => l.instrument_id === 'A')?.intent).toBe('INCREASE');
    expect(lines.find((l) => l.instrument_id === 'B')?.intent).toBe('NO_CHANGE');
  });

  it('turnover budget defers smallest deltas first-cutoff', () => {
    const current = [pos('A', 0, { qty: 0, side: 0 })];
    const { lines } = diffRebalance({
      current, targets: { A: 1000, B: 10 }, prices: { A: 100, B: 100 },
      turnoverBudgetPct: 100, equity: 1_000_000, cost_model: COST
    });
    // Need 100k + 1k; budget 10.05% (100.5k) keeps A, defers B.
    const budgeted = applyTurnoverBudget(lines, { A: 100, B: 100 }, 1_000_000, 10.05);
    expect(budgeted.deferred).toEqual(['B']);
    expect(budgeted.lines.find((l) => l.instrument_id === 'A')?.intent).not.toBe('NO_CHANGE');
    expect(budgeted.lines.find((l) => l.instrument_id === 'B')?.intent).toBe('NO_CHANGE');
    expect(budgeted.turnover_pct).toBeLessThanOrEqual(10.05);
  });
});

describe('mark-to-market', () => {
  it('marks positions with provenance prices and tracks drawdown', () => {
    const m = markToMarket([pos('A', 10_000)], { A: 110 }, 1_000_000, 1_000_000, 1_010_000);
    expect(m.positions[0]?.mark_price).toBe(110);
    expect(m.positions[0]?.unrealized_pnl).toBe(1000);
    expect(m.daily_pnl_pct).toBeCloseTo(1);
    expect(m.drawdown_pct).toBe(0);
    const dd = markToMarket([pos('A', 10_000)], { A: 90 }, 1_010_000, 1_010_000, 900_000);
    expect(dd.drawdown_pct).toBeCloseTo(-10.89, 1);
  });
});

describe('decision records and snapshots', () => {
  it('summarizes NO_TRADE vs RISK_BLOCKED vs TRADE distinctly', () => {
    const base = {
      decision_id: 'd', timestamp: 1, portfolio_id: 'p', portfolio_version: 1, candidates: [],
      proposed: {}, approved: {}, reduced: [], rejected: [], risk_decisions: [], positions: [],
      equity: 1_000_000, expected_turnover: 0, estimated_costs: 0, assumptions: [], evidence_refs: [], versions: {}
    };
    expect(summarizeDecision(base).outcome).toBe('NO_TRADE');
    expect(summarizeDecision({ ...base, rejected: [{ instrument_id: 'A', rule_id: 'r', reason: 'x' }] }).outcome).toBe('RISK_BLOCKED');
    expect(summarizeDecision({ ...base, approved: { A: 10 } }).outcome).toBe('TRADE');
  });

  it('snapshots are deep copies', () => {
    const state = {
      portfolio_id: 'p', version: 1,
      capital: { total: 1, cash: 1, invested: 0, available: 1, reserved: 0, margin_used: 0, free_margin: 1, gross_exposure: 0, net_exposure: 0 },
      positions: [pos('A', 100)], realized_pnl: 0, unrealized_pnl: 0, drawdown_pct: 0,
      peak_equity: 1, daily_pnl_pct: 0, drawdown_state: 'NORMAL' as const, status: 'ACTIVE',
      updated_at: 1, provenance: { source: 't', source_type: 'agent' as const, evidence_refs: [] }
    };
    const snap = buildSnapshot(state);
    snap.positions[0]!.qty = 999;
    expect(state.positions[0]?.qty).not.toBe(999);
  });
});
