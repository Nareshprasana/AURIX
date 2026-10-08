// Performance metrics, benchmark comparison and strategy evaluation.
// Risk-free rate is 0 unless stated; annualization assumes 252 sessions/year for
// daily bars (caller overrides via barsPerYear). Thresholds documented inline.
import type { EvaluationLabel, PerformanceMetrics, Trade } from './types.js';

export function computeMetrics(
  equity: number[],
  trades: Trade[],
  initialCash: number,
  barsPerYear = 252
): PerformanceMetrics {
  const n = equity.length;
  const totalReturn = initialCash > 0 && n > 0 ? equity[n - 1]! / initialCash - 1 : 0;
  const years = n / Math.max(1, barsPerYear);
  const cagr = years > 0 && n > 0 && equity[n - 1]! > 0 && initialCash > 0
    ? Math.pow(equity[n - 1]! / initialCash, 1 / years) - 1
    : 0;
  const rets: number[] = [];
  for (let i = 1; i < n; i++) rets.push(equity[i]! / equity[i - 1]! - 1);
  const mean = rets.length > 0 ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
  const volatility = rets.length > 1
    ? Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(barsPerYear)
    : 0;
  let peak = initialCash;
  let maxDd = 0;
  let ddStart = 0;
  let maxDdDur = 0;
  for (let i = 0; i < n; i++) {
    if (equity[i]! > peak) {
      peak = equity[i]!;
      ddStart = i;
    }
    const dd = peak > 0 ? (equity[i]! - peak) / peak : 0;
    if (dd < maxDd) {
      maxDd = dd;
      maxDdDur = Math.max(maxDdDur, i - ddStart);
    }
  }
  const downside = rets.filter((r) => r < 0);
  const downsideDev = downside.length > 0
    ? Math.sqrt(downside.reduce((s, v) => s + v * v, 0) / downside.length) * Math.sqrt(barsPerYear)
    : 0;
  const sharpe = volatility > 0 ? (mean * barsPerYear) / volatility : 0;
  const sortino = downsideDev > 0 ? (mean * barsPerYear) / downsideDev : 0;
  const calmar = maxDd < 0 ? cagr / Math.abs(maxDd) : 0;
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const wins = closed.filter((t) => t.realized_pnl > 0);
  const losses = closed.filter((t) => t.realized_pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.realized_pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realized_pnl, 0));
  const turnover = closed.reduce((s, t) => s + Math.abs(t.entry_price * t.qty) + Math.abs((t.exit_price ?? 0) * t.qty), 0);
  const worstTrade = closed.length > 0 ? Math.min(...closed.map((t) => t.realized_pnl)) : 0;
  let lossStreak = 0;
  let cur = 0;
  for (const t of closed) {
    cur = t.realized_pnl <= 0 ? cur + 1 : 0;
    lossStreak = Math.max(lossStreak, cur);
  }
  const totalProfit = grossWin - grossLoss;
  const concentration = totalProfit > 0 && closed.length > 0
    ? Math.max(...closed.map((t) => t.realized_pnl)) / totalProfit
    : 0;
  return {
    total_return: totalReturn,
    cagr,
    volatility,
    max_drawdown: maxDd,
    max_dd_duration_bars: maxDdDur,
    downside_dev: downsideDev,
    sharpe,
    sortino,
    calmar,
    trades: closed.length,
    win_rate: closed.length > 0 ? wins.length / closed.length : 0,
    avg_win: wins.length > 0 ? grossWin / wins.length : 0,
    avg_loss: losses.length > 0 ? -grossLoss / losses.length : 0,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    turnover,
    avg_holding_bars: closed.length > 0 ? closed.reduce((s, t) => s + t.holding_bars, 0) / closed.length : 0,
    worst_day: rets.length > 0 ? Math.min(...rets) : 0,
    worst_trade: worstTrade,
    loss_streak: lossStreak,
    concentration
  };
}

export interface BenchmarkComparison {
  strategy_return: number;
  benchmark_return: number;
  excess_return: number;
  strategy_vol: number;
  benchmark_vol: number;
  strategy_maxdd: number;
  benchmark_maxdd: number;
}

export function compareBenchmark(strategy: PerformanceMetrics, benchmark: PerformanceMetrics): BenchmarkComparison {
  return {
    strategy_return: strategy.total_return,
    benchmark_return: benchmark.total_return,
    excess_return: strategy.total_return - benchmark.total_return,
    strategy_vol: strategy.volatility,
    benchmark_vol: benchmark.volatility,
    strategy_maxdd: strategy.max_drawdown,
    benchmark_maxdd: benchmark.max_drawdown
  };
}

export interface EvaluationInput {
  inSample: PerformanceMetrics;
  inSampleTrades: number;
  inSampleBars: number;
  oos?: PerformanceMetrics;
  walkForward?: { windows: number; aggregate: PerformanceMetrics };
  stressWorstDd?: number;
  paramStable?: boolean;
  sweepCount?: number;
  methodologyFlags?: string[];
}

const MIN_TRADES = 10;
const MIN_BARS = 60;

/** Deterministic evaluation. Positive returns alone never approve. */
export function evaluateStrategy(input: EvaluationInput): { label: EvaluationLabel; reasons: string[] } {
  const reasons: string[] = [];
  if ((input.methodologyFlags ?? []).length > 0) {
    return { label: 'INVALID', reasons: [`methodology flags: ${input.methodologyFlags!.join(', ')}`] };
  }
  if (input.inSampleTrades < MIN_TRADES || input.inSampleBars < MIN_BARS) {
    return { label: 'INSUFFICIENT_DATA', reasons: [`trades=${input.inSampleTrades} bars=${input.inSampleBars} (need ≥${MIN_TRADES}/≥${MIN_BARS})`] };
  }
  const m = input.inSample;
  if (m.total_return <= 0 || m.profit_factor < 1) {
    reasons.push(`unprofitable after costs (return=${m.total_return.toFixed(3)}, pf=${m.profit_factor.toFixed(2)})`);
    return { label: 'REJECTED', reasons };
  }
  if (m.max_drawdown < -0.4) {
    reasons.push(`drawdown ${(m.max_drawdown * 100).toFixed(1)}% exceeds 40%`);
    return { label: 'REJECTED', reasons };
  }
  if (input.oos && input.oos.sharpe < 0.5 * m.sharpe && m.sharpe > 0) {
    reasons.push(`OOS sharpe ${input.oos.sharpe.toFixed(2)} < 50% of IS ${m.sharpe.toFixed(2)}: degraded out of sample`);
    return { label: 'DEGRADED', reasons };
  }
  const hasOos = !!input.oos;
  const hasWf = !!input.walkForward && input.walkForward.windows > 0;
  const stressOk = input.stressWorstDd === undefined || input.stressWorstDd >= 1.5 * m.max_drawdown;
  if (!stressOk) reasons.push('stress drawdown exceeds 1.5x base');
  if (input.paramStable === false) reasons.push('no stable parameter region');
  if ((input.sweepCount ?? 1) > 50 && !hasOos) reasons.push(`best-of-${input.sweepCount} without OOS confirmation`);
  if (hasOos && hasWf && stressOk && input.paramStable !== false && input.oos!.total_return > 0) {
    reasons.push('IS+OOS+WF+stress+params all pass');
    return { label: 'ROBUST', reasons };
  }
  if (hasOos && input.oos!.total_return > 0 && input.oos!.sharpe >= 0) {
    reasons.push('positive OOS with non-negative sharpe');
    return { label: 'PROMISING', reasons };
  }
  reasons.push('meets profitability gates but lacks full validation breadth');
  return { label: 'WEAK', reasons };
}
