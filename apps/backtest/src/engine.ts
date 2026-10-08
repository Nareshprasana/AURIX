// Deterministic backtest engine: point-in-time event loop, 1-bar execution
// delay, hypothetical orders only (simulation-side order type), fill simulation with
// costs/slippage/liquidity, simulation accounting. No look-ahead by construction:
// signals at bar i read data <= i; fills happen at bars > i.
import type {
  BacktestState,
  CostModel,
  Fill,
  HypotheticalOrder,
  PerformanceMetrics,
  Signal,
  SlippageModel,
  StrategyDefinition,
  Trade
} from '@aurix/strategy';
import {
  checkLiquidity,
  computeCost,
  computeSlippage,
  generateSignals,
  TradingCalendar
} from '@aurix/strategy';
import { computeMetrics } from '@aurix/strategy';
import type { AdjustedSeries, BacktestDataset, DatasetBar } from './datasets.js';
import { adjustSeries } from './datasets.js';
import { cyrb53hex, stableStringify } from '@aurix/knowledge-service';

export const BACKTEST_CODE_VERSION = 'backtest-v1';

export interface EventWindow {
  instrument_id: string;
  from_ts: number;
  to_ts: number;
}

export interface BacktestRequest {
  dataset: BacktestDataset;
  strategy: StrategyDefinition;
  calendar: TradingCalendar;
  initial_cash: number;
  exec_delay_bars?: number;
  eventWindows?: EventWindow[];
  abnormal?: boolean;
  barsPerYear?: number;
  dataVersion?: string;
  generatedAt?: number;
  quality?: { status: 'VALID' | 'QUARANTINED' | 'MIXED'; badIds: string[] };
}

export interface BacktestRun {
  status: BacktestState['status'];
  reason: string | null;
  signals: Signal[];
  orders: HypotheticalOrder[];
  fills: Fill[];
  trades: Trade[];
  equity: { ts: number; equity: number }[];
  metrics: ReturnType<typeof computeMetrics>;
  benchmark: ReturnType<typeof computeMetrics> | null;
  limitations: string[];
  methodology: string[];
  appliedAdjustments: { action_id: string; method: string; version: string }[];
  specHash: string;
  codeVersion: string;
  suppressedByWindow: number;
  skippedIlliquid: number;
  skippedCash: number;
  dividendsCredited: number;
}

interface OpenPosition {
  qty: number;
  avg_price: number;
  side: 1 | -1;
  entry_ts: number;
  trade_id: string;
  fees_paid: number;
  margin: number;
}

interface EngineState {
  cash: number;
  marginLocked: number;
  positions: Map<string, OpenPosition>;
  orderSeq: number;
  tradeSeq: number;
}

function sessionOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function specHashFor(input: {
  dataset: BacktestDataset;
  strategy: StrategyDefinition;
  params: Record<string, number>;
  from_ts: number;
  to_ts: number;
  cost_model: CostModel;
  slippage_model: SlippageModel;
}): string {
  return cyrb53hex(stableStringify({
    strategy: `${input.strategy.id}:v${input.strategy.version}`,
    params: input.params,
    dataset: input.dataset.version,
    range: [input.from_ts, input.to_ts],
    cost: input.cost_model,
    slippage: input.slippage_model,
    code: BACKTEST_CODE_VERSION
  }));
}

function barsPerYear(timeframe: string): number {
  if (timeframe === '1W') return 52;
  if (timeframe === '1M') return 12;
  if (timeframe === '1h') return 1500;
  return 252;
}

function advFor(bars: DatasetBar[], j: number): number | null {
  let v = 0;
  let n = 0;
  for (let k = Math.max(0, j - 20); k < j; k++) {
    const b = bars[k];
    if (!b) continue;
    v += b.volume * b.close;
    n++;
  }
  return n > 0 ? v / n : null;
}

/** Next session bar at least `delay` session-bars after i; null when unavailable. */
function executionIndex(bars: DatasetBar[], i: number, delay: number, calendar: TradingCalendar): number | null {
  let seen = 0;
  for (let j = i + 1; j < bars.length; j++) {
    if (!calendar.isSession(bars[j]!.ts)) continue;
    seen++;
    if (seen === delay) return j;
  }
  return null;
}

function sizingQty(strategy: StrategyDefinition, refPrice: number, advValue: number | null): { qty: number; cappedBy: string[] } {
  const s = strategy.sizing;
  const cappedBy: string[] = [];
  let qty = s.type === 'fixed-qty' ? Math.floor(s.qty ?? 0) : Math.floor((s.notional ?? 0) / refPrice);
  if (refPrice * qty > s.max_notional) {
    qty = Math.floor(s.max_notional / refPrice);
    cappedBy.push('max_notional');
  }
  if (advValue !== null && advValue > 0 && refPrice > 0) {
    const advQty = Math.floor((advValue * (s.max_adv_pct / 100)) / refPrice);
    if (qty > advQty) {
      qty = advQty;
      cappedBy.push('max_adv_pct');
    }
  }
  return { qty: Math.max(0, qty), cappedBy };
}

export function runBacktest(req: BacktestRequest): BacktestRun {
  const now = req.generatedAt ?? Date.now();
  const out: BacktestRun = {
    status: 'FAILED', reason: null, signals: [], orders: [], fills: [], trades: [],
    equity: [], metrics: computeMetrics([], [], req.initial_cash),
    benchmark: null, limitations: [...req.dataset.limitations], methodology: [], appliedAdjustments: [],
    specHash: '', codeVersion: BACKTEST_CODE_VERSION,
    suppressedByWindow: 0, skippedIlliquid: 0, skippedCash: 0, dividendsCredited: 0
  };
  try {
    return executeRun(req, now, out);
  } catch (e) {
    out.status = 'FAILED';
    out.reason = e instanceof Error ? e.message : String(e);
    return out;
  }
}

function executeRun(req: BacktestRequest, now: number, out: BacktestRun): BacktestRun {
  const delay = req.exec_delay_bars ?? 1;
  const bad = new Set(req.quality?.badIds ?? []);
  const adjusted = adjustSeries(req.dataset);
  for (const s of adjusted) {
    for (const a of s.applied) {
      if (!out.appliedAdjustments.some((x) => x.action_id === a.action_id)) out.appliedAdjustments.push(a);
    }
  }
  const eligible = adjusted.filter((s) => !bad.has(s.instrument_id));
  if (adjusted.length === 0 || eligible.length === 0) {
    out.status = req.quality?.status === 'QUARANTINED' ? 'DATA_QUARANTINED' : 'INSUFFICIENT_DATA';
    out.reason = 'no tradable instruments (empty universe or all quarantined)';
    return out;
  }
  const sessionSet = new Set<string>();
  for (const s of eligible) {
    for (const b of s.bars) {
      if (req.calendar.isSession(b.ts)) sessionSet.add(sessionOf(b.ts));
    }
  }
  const sessions = [...sessionSet].sort();
  if (sessions.length < 2) {
    out.status = 'INSUFFICIENT_DATA';
    out.reason = 'fewer than 2 trading sessions overlap the dataset';
    return out;
  }
  out.methodology.push(
    'signals at bar i use data <= i only (structural no-look-ahead)',
    `execution delayed ${delay} session-bar(s) after signal (no same-bar fills)`,
    'shorts are cash-secured at 100% (no leverage, no interest)',
    'entries blocked on illiquid/unknown liquidity; exits fill capped, never blocked',
    'benchmark pays entry+exit costs like the strategy'
  );
  out.limitations.push(
    'single open position per instrument (no pyramiding)',
    'intraday bars share the session gate of their calendar date',
    'dividends credit long holders only; short dividend liabilities not modeled'
  );
  out.specHash = specHashFor({
    dataset: req.dataset,
    strategy: req.strategy,
    params: req.strategy.params,
    from_ts: req.dataset.range.from_ts,
    to_ts: req.dataset.range.to_ts,
    cost_model: req.strategy.cost_model,
    slippage_model: req.strategy.slippage_model
  });

  const st: EngineState = { cash: req.initial_cash, marginLocked: 0, positions: new Map(), orderSeq: 0, tradeSeq: 0 };
  const listedAt = new Map(req.dataset.universe.map((u) => [u.instrument_id, u.listing_ts]));
  const splits = req.dataset.adjustments.slice().sort((a, b) => a.ex_ts - b.ex_ts);
  const appliedSplit = new Set<string>();
  const appliedDividend = new Set<string>();
  const snaps = new Map<string, { cash: number; positions: { id: string; qty: number; avg: number; side: 1 | -1 }[] }>();

  const snapshot = (ts: number): void => {
    snaps.set(sessionOf(ts), {
      cash: st.cash,
      positions: [...st.positions.entries()].map(([id, p]) => ({ id, qty: p.qty, avg: p.avg_price, side: p.side }))
    });
  };

  for (const series of eligible) {
    if (series.bars.length === 0) continue;
    if ((listedAt.get(series.instrument_id) ?? 0) > series.bars[series.bars.length - 1]!.ts) continue;
    const closes = series.bars.map((b) => b.close);
    const timestamps = series.bars.map((b) => b.ts);
    const batch = generateSignals(req.strategy, series.instrument_id, closes, timestamps, req.dataVersion ?? req.dataset.version, now, req.abnormal ?? false);
    for (const sig of batch.signals) out.signals.push(sig);
    if (batch.status === 'NOT_APPLICABLE') continue;

    for (let i = 0; i < series.bars.length; i++) {
      const bar = series.bars[i]!;
      if (!req.calendar.isSession(bar.ts)) continue;
      if (bar.ts < (listedAt.get(series.instrument_id) ?? 0)) continue;
      applyCorporateActions(req, out, st, series.instrument_id, bar.ts, splits, appliedSplit);
      applyDividends(req, out, st, series.instrument_id, bar.ts, appliedDividend);
      const inWindow = !req.eventWindows || req.eventWindows.some((w) =>
        w.instrument_id === series.instrument_id && bar.ts >= w.from_ts && bar.ts <= w.to_ts);
      const sig = batch.signals[i]!;
      if (!inWindow) {
        if (sig.type === 'LONG' || sig.type === 'SHORT') out.suppressedByWindow++;
        snapshot(bar.ts);
        continue;
      }
      const cur = st.positions.get(series.instrument_id);
      const pos: 1 | -1 | 0 = cur ? cur.side : 0;
      if (pos === 1 && (sig.type === 'EXIT' || sig.type === 'SHORT')) {
        fillExit(req, out, st, series, i, delay, series.instrument_id);
        if (sig.type === 'SHORT') fillEntry(req, out, st, series, i, delay, -1, sig);
      } else if (pos === -1 && (sig.type === 'EXIT' || sig.type === 'LONG')) {
        fillExit(req, out, st, series, i, delay, series.instrument_id);
        if (sig.type === 'LONG') fillEntry(req, out, st, series, i, delay, 1, sig);
      } else if (pos === 0 && (sig.type === 'LONG' || sig.type === 'SHORT')) {
        fillEntry(req, out, st, series, i, delay, sig.type === 'LONG' ? 1 : -1, sig);
      }
      snapshot(bar.ts);
    }
  }

  out.equity = buildEquity(req, eligible, sessions, st, snaps);
  out.metrics = computeMetrics(out.equity.map((e) => e.equity), out.trades, req.initial_cash, barsPerYear(req.dataset.timeframe));
  out.benchmark = runBenchmark(req, eligible, sessions);
  if (req.quality?.status === 'MIXED') {
    out.status = 'PARTIAL';
    out.reason = 'some instruments excluded by data quality';
  } else {
    out.status = 'COMPLETED';
  }
  return out;
}

function fillEntry(
  req: BacktestRequest,
  out: BacktestRun,
  st: EngineState,
  series: AdjustedSeries,
  i: number,
  delay: number,
  dir: 1 | -1,
  sig: { ts: number }
): boolean {
  const j = executionIndex(series.bars, i, delay, req.calendar);
  if (j === null) return false;
  const execBar = series.bars[j]!;
  const adv = advFor(series.bars, j);
  const { qty: rawQty, cappedBy } = sizingQty(req.strategy, execBar.open, adv);
  if (rawQty <= 0) return false;
  const liq = checkLiquidity(
    execBar.close * execBar.volume, execBar.volume, adv,
    execBar.spread_bps, rawQty, req.strategy.liquidity, false
  );
  if (!liq.ok) {
    out.skippedIlliquid++;
    return false;
  }
  const qty = Math.min(rawQty, liq.cappedQty);
  if (qty <= 0) {
    out.skippedIlliquid++;
    return false;
  }
  const slip = computeSlippage(execBar.open * qty, req.strategy.slippage_model, { spread_bps: execBar.spread_bps, adv_value: adv });
  const slipAbs = (execBar.open * slip.slippage_bps) / 10_000;
  const price = dir === 1 ? execBar.open + slipAbs : execBar.open - slipAbs;
  const notional = price * qty;
  const cost = computeCost(notional, req.strategy.cost_model);
  const available = st.cash - st.marginLocked;
  if (available < notional + cost.total) {
    out.skippedCash++;
    return false;
  }
  st.orderSeq++;
  const orderId = `hyp-${st.orderSeq}`;
  out.orders.push({
    id: orderId,
    strategy_id: req.strategy.id,
    strategy_version: req.strategy.version,
    instrument_id: series.instrument_id,
    ts_signal: sig.ts,
    ts_execute: execBar.ts,
    side: dir === 1 ? 'BUY' : 'SELL',
    qty,
    ref_price: execBar.open,
    reason: `signal@${sig.ts}${cappedBy.length > 0 ? ` capped:${cappedBy.join(',')}` : ''}`
  });
  out.fills.push({
    order_id: orderId,
    instrument_id: series.instrument_id,
    ts: execBar.ts,
    price,
    qty,
    fees: cost.total,
    fee_breakdown: { brokerage: cost.brokerage, exchange: cost.exchange, taxes: cost.taxes },
    slippage_bps: slip.slippage_bps,
    slippage_assumptions: slip.assumed,
    liquidity_capped: qty < rawQty
  });
  st.tradeSeq++;
  if (dir === 1) {
    st.cash -= notional + cost.total;
  } else {
    st.cash += notional - cost.total;
    st.marginLocked += notional;
  }
  st.positions.set(series.instrument_id, {
    qty, avg_price: price, side: dir, entry_ts: execBar.ts, trade_id: `tr-${st.tradeSeq}`, fees_paid: cost.total, margin: dir === -1 ? notional : 0
  });
  return true;
}

function fillExit(
  req: BacktestRequest,
  out: BacktestRun,
  st: EngineState,
  series: AdjustedSeries,
  i: number,
  delay: number,
  instrument_id: string
): boolean {
  const pos = st.positions.get(instrument_id);
  if (!pos) return false;
  const j = executionIndex(series.bars, i, delay, req.calendar);
  if (j === null) return false;
  const execBar = series.bars[j]!;
  const adv = advFor(series.bars, j);
  const liq = checkLiquidity(
    execBar.close * execBar.volume, execBar.volume, adv,
    execBar.spread_bps, pos.qty, req.strategy.liquidity, true
  );
  const qty = Math.min(pos.qty, liq.cappedQty > 0 ? liq.cappedQty : pos.qty);
  if (qty <= 0) return false;
  const slip = computeSlippage(execBar.open * qty, req.strategy.slippage_model, { spread_bps: execBar.spread_bps, adv_value: adv });
  const slipAbs = (execBar.open * slip.slippage_bps) / 10_000;
  const price = pos.side === 1 ? execBar.open - slipAbs : execBar.open + slipAbs;
  const notional = price * qty;
  const cost = computeCost(notional, req.strategy.cost_model);
  st.orderSeq++;
  const orderId = `hyp-${st.orderSeq}`;
  const sigTs = series.bars[i]!.ts;
  out.orders.push({
    id: orderId,
    strategy_id: req.strategy.id,
    strategy_version: req.strategy.version,
    instrument_id,
    ts_signal: sigTs,
    ts_execute: execBar.ts,
    side: pos.side === 1 ? 'EXIT_LONG' : 'EXIT_SHORT',
    qty,
    ref_price: execBar.open,
    reason: 'signal-exit'
  });
  out.fills.push({
    order_id: orderId,
    instrument_id,
    ts: execBar.ts,
    price,
    qty,
    fees: cost.total,
    fee_breakdown: { brokerage: cost.brokerage, exchange: cost.exchange, taxes: cost.taxes },
    slippage_bps: slip.slippage_bps,
    slippage_assumptions: slip.assumed,
    liquidity_capped: qty < pos.qty
  });
  const pnl = pos.side === 1 ? (price - pos.avg_price) * qty : (pos.avg_price - price) * qty;
  if (pos.side === 1) {
    st.cash += notional - cost.total;
  } else {
    st.cash -= notional + cost.total;
    st.marginLocked -= Math.min(st.marginLocked, pos.margin * (qty / pos.qty));
  }
  const remaining = pos.qty - qty;
  const trade: Trade = {
    trade_id: pos.trade_id,
    instrument_id,
    direction: pos.side,
    entry_ts: pos.entry_ts,
    entry_price: pos.avg_price,
    exit_ts: execBar.ts,
    exit_price: price,
    qty,
    realized_pnl: pnl - cost.total - pos.fees_paid * (qty / pos.qty),
    fees: cost.total + pos.fees_paid * (qty / pos.qty),
    holding_bars: j - i,
    status: 'CLOSED'
  };
  if (remaining <= 0) {
    out.trades.push(trade);
    st.positions.delete(instrument_id);
  } else {
    out.trades.push({ ...trade, status: 'OPEN', exit_ts: null, exit_price: null, realized_pnl: 0 });
    st.positions.set(instrument_id, { ...pos, qty: remaining });
  }
  return true;
}

function applyCorporateActions(
  req: BacktestRequest,
  out: BacktestRun,
  st: EngineState,
  instrument_id: string,
  ts: number,
  splits: BacktestDataset['adjustments'],
  appliedSplit: Set<string>
): void {
  void req;
  for (const a of splits) {
    if (a.instrument_id !== instrument_id || ts < a.ex_ts || appliedSplit.has(`${a.id}@${instrument_id}`)) continue;
    appliedSplit.add(`${a.id}@${instrument_id}`);
    const pos = st.positions.get(instrument_id);
    // Prices are pre-adjusted; scale the open quantity so exposure is continuous.
    if (pos && (a.type === 'split' || a.type === 'bonus')) {
      pos.qty = Math.floor(pos.qty * a.factor);
      pos.avg_price = pos.avg_price / a.factor;
    }
    out.limitations.push(`corporate action ${a.id} (${a.type} x${a.factor}) applied at ${new Date(ts).toISOString()}`);
  }
}

function applyDividends(
  req: BacktestRequest,
  out: BacktestRun,
  st: EngineState,
  instrument_id: string,
  ts: number,
  appliedDividend: Set<string>
): void {
  for (const d of req.dataset.dividends) {
    if (d.instrument_id !== instrument_id || ts < d.ex_ts || appliedDividend.has(`${d.id}@${instrument_id}`)) continue;
    appliedDividend.add(`${d.id}@${instrument_id}`);
    const pos = st.positions.get(instrument_id);
    if (pos && pos.side === 1 && pos.qty > 0) {
      const credit = pos.qty * d.amount_per_share;
      st.cash += credit;
      out.dividendsCredited += credit;
    }
  }
}

function buildEquity(
  req: BacktestRequest,
  eligible: AdjustedSeries[],
  sessions: string[],
  st: EngineState,
  snaps: Map<string, { cash: number; positions: { id: string; qty: number; avg: number; side: 1 | -1 }[] }>
): { ts: number; equity: number }[] {
  void req;
  const closesByInst = new Map<string, { ts: number; close: number }[]>();
  for (const s of eligible) {
    closesByInst.set(s.instrument_id, s.bars.map((b) => ({ ts: b.ts, close: b.close })));
  }
  const out: { ts: number; equity: number }[] = [];
  // Point-in-time snapshots; sessions before any snapshot reuse the last known
  // state. Snapshot cash is end-of-day (fills same day already applied).
  let curCash = req.initial_cash;
  let curPositions: { id: string; qty: number; avg: number; side: 1 | -1 }[] = [];
  for (const session of sessions) {
    const dayEnd = Date.parse(`${session}T23:59:59Z`);
    const snap = snaps.get(session);
    if (snap) {
      curCash = snap.cash;
      curPositions = snap.positions;
    }
    let positionsMv = 0;
    for (const pos of curPositions) {
      const series = closesByInst.get(pos.id) ?? [];
      let mark = 0;
      for (const b of series) {
        if (b.ts <= dayEnd) mark = b.close;
        else break;
      }
      positionsMv += pos.side * pos.qty * mark;
    }
    out.push({ ts: dayEnd, equity: curCash + positionsMv });
  }
  return out;
}

function runBenchmark(
  req: BacktestRequest,
  eligible: AdjustedSeries[],
  sessions: string[]
): PerformanceMetrics | null {
  if (eligible.length === 0 || sessions.length < 2) return null;
  const perInst = req.initial_cash / eligible.length;
  let cash = 0;
  const holdings = new Map<string, { qty: number; entry_fees: number }>();
  const equity: number[] = [];
  for (const session of sessions) {
    let mv = cash;
    for (const s of eligible) {
      let bar: DatasetBar | null = null;
      for (const b of s.bars) {
        if (sessionOf(b.ts) <= session) bar = b;
        else break;
      }
      if (!bar) continue;
      const h = holdings.get(s.instrument_id);
      if (!h) {
        const qty = Math.floor(perInst / bar.open);
        if (qty > 0) {
          const cost = computeCost(qty * bar.open, req.strategy.cost_model);
          cash += perInst - qty * bar.open - cost.total;
          holdings.set(s.instrument_id, { qty, entry_fees: cost.total });
        }
        mv += (holdings.get(s.instrument_id)?.qty ?? 0) * bar.close;
      } else {
        mv += h.qty * bar.close;
      }
    }
    equity.push(mv);
  }
  // Exit costs at the end (fair comparison).
  let exitFees = 0;
  for (const [id, h] of holdings) {
    const series = eligible.find((s) => s.instrument_id === id);
    const last = series?.bars[series.bars.length - 1];
    if (last) exitFees += computeCost(h.qty * last.close, req.strategy.cost_model).total;
  }
  const net = equity.map((e, i) => (i === equity.length - 1 ? e - exitFees : e));
  return computeMetrics(net, [], req.initial_cash, 252);
}
