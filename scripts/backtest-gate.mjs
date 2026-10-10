// Backtest gate for the training orchestrator: real bars through the EXISTING
// backtest engine with cost/slippage/liquidity-aware settings.
// Modes (exactly one JSON line on stdout):
//   (default)       single backtest over all bars
//   --walkforward T,t,s[,maxW]  walk-forward over rolling windows (train T,
//                   test t, step s bars; at most maxW windows, default 4)
//   --stress        cost×2 and spread/slippage-shock stress scenarios
// ok=true means the engine ran cleanly with point-in-time discipline (NOT that
// the strategy is profitable — classification accuracy != profitability).
// Usage: node --import ./scripts/aurix-register.mjs scripts/backtest-gate.mjs <bars.json> [--walkforward ...] [--stress]
import { readFileSync } from 'node:fs';
import { buildDataset, runBacktest, runWalkForward, makeWindows, runStress } from '../dist/apps/backtest/src/index.js';
import { FAMILY_PRESETS, TradingCalendar } from '../dist/packages/strategy/src/index.js';

const barsPath = process.argv[2];
if (!barsPath) throw new Error('usage: backtest-gate.mjs <backtest-bars.json> [--walkforward T,t,s[,maxW]] [--stress]');
const bars = JSON.parse(readFileSync(barsPath, 'utf8'));
const universe = [...new Set(bars.map((b) => b.instrument_id))];
const dataset = buildDataset({ id: 'gate', timeframe: '1D', bars, source: 'orchestrator-gate', calendar_version: 'cal-weekday-v1' });
const conditions = FAMILY_PRESETS['roc-momentum'].build({ n: 1, threshold: 0 });
const strategy = {
  id: 'gate:roc', version: 1, name: 'gate', description: 'orchestrator backtest gate',
  family: 'momentum', scope: { markets: ['equity'], segments: ['EQ'], timeframes: ['1D'], universe },
  entry_long: conditions.entry_long, entry_short: conditions.entry_short, exit: conditions.exit,
  sizing: { type: 'fixed-qty', qty: 1, max_notional: 1_000_000, max_adv_pct: 10 },
  signal_horizon_bars: 5, required_observations: [], required_data: ['ohlcv'], required_events: [],
  assumptions: ['gate only'], cost_model: { brokerage_bps: 5, exchange_bps: 2, taxes_bps: 3, min_cost: 0, per_side: true },
  slippage_model: { kind: 'fixed-bps', base_bps: 5 },
  liquidity: { min_value: 1000, min_volume: 1000, max_participation: 10, max_adv_pct: 10, max_spread_bps: 100 },
  regimes: { supported: [], preferred: [], blocked: [] },
  params: { n: 1, threshold: 0 }, param_bounds: { n: [1, 10], threshold: [0, 1] },
  family_preset: 'roc-momentum', created_at: 1, author: 'backtest-gate',
  provenance: { source: 'backtest-gate', source_type: 'agent', evidence_refs: [] },
  evidence_refs: [], status: 'CANDIDATE'
};
const from = new Date(dataset.range.from_ts).toISOString().slice(0, 10);
const to = new Date(dataset.range.to_ts).toISOString().slice(0, 10);
const calendar = TradingCalendar.weekdays(from, to, [], 'cal-weekday-v1');
const base = { dataset, strategy, calendar, initial_cash: 100_000, dataVersion: dataset.version, generatedAt: Date.now() };

function checkPit(run) {
  for (const o of run.orders) {
    if (!(o.ts_execute > o.ts_signal)) {
      console.log(JSON.stringify({ ok: false, reason: 'point-in-time violation' }));
      process.exit(0);
    }
  }
}

const args = process.argv.slice(3);
const wfArg = args.find((a) => a.startsWith('--walkforward'));
if (wfArg) {
  const spec = (wfArg.split(' ')[1] || wfArg.split('=')[1] || '60,20,20').split(',').map(Number);
  const [trainBars, testBars, stepBars] = spec;
  const maxW = spec[3] ?? 4;
  if (![trainBars, testBars, stepBars].every((n) => Number.isInteger(n) && n > 0)) {
    console.log(JSON.stringify({ ok: false, reason: 'WALK_WINDOW_INVALID' }));
    process.exit(0);
  }
  const sessions = [...new Set(bars.map((b) => new Date(b.ts).toISOString().slice(0, 10)))].sort();
  let windows;
  try {
    windows = makeWindows(sessions, trainBars, testBars, stepBars).slice(0, maxW);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: String(e?.message ?? e) }));
    process.exit(0);
  }
  const wf = runWalkForward(base, dataset, windows);
  const tests = wf.windows.map((w) => ({
    trainFrom: w.window.trainFrom, testFrom: w.window.testFrom,
    status: w.test.status, trades: w.test.trades.length,
    sharpe: w.test.metrics.sharpe ?? 0, max_drawdown: Math.abs(w.test.metrics.max_drawdown ?? 0)
  }));
  const sharpes = tests.filter((t) => t.status === 'COMPLETED').map((t) => t.sharpe);
  sharpes.sort((a, b) => a - b);
  const medianSharpe = sharpes.length ? sharpes[Math.floor(sharpes.length / 2)] : null;
  console.log(JSON.stringify({
    ok: tests.length > 0 && tests.every((t) => t.status === 'COMPLETED'),
    status: 'WALKFORWARD', windows: tests.length, window_tests: tests,
    median_test_sharpe: medianSharpe,
    reason: tests.length === 0 ? 'no windows evaluated' : null
  }));
  process.exit(0);
}

if (args.includes('--stress')) {
  const scenarios = [
    { name: 'cost-x2', costMult: 2 },
    { name: 'friction-shock', slippageMult: 3, spreadAddBps: 10, participationMult: 0.5 }
  ];
  const results = runStress(base, scenarios).map((r) => ({
    scenario: r.scenario, status: r.run.status,
    trades: r.run.trades.length, baseSharpe: r.baseSharpe, stressedSharpe: r.stressedSharpe,
    baseDd: Math.abs(r.baseDd ?? 0), stressedDd: Math.abs(r.stressedDd ?? 0)
  }));
  console.log(JSON.stringify({
    ok: results.length > 0 && results.every((r) => r.status === 'COMPLETED'),
    status: 'STRESS', scenarios: results,
    max_stressed_dd: results.length ? Math.max(...results.map((r) => r.stressedDd)) : null,
    reason: results.length === 0 ? 'no scenarios evaluated' : null
  }));
  process.exit(0);
}

const run = runBacktest(base);
checkPit(run);
console.log(JSON.stringify({
  ok: run.status === 'COMPLETED',
  status: run.status,
  orders: run.orders.length,
  fills: run.fills.length,
  trades: run.trades.length,
  signals: run.signals?.length ?? null,
  max_drawdown_pct: Math.abs(run.metrics.max_drawdown ?? 0),
  total_return: run.metrics.total_return ?? 0,
  limitations: dataset.limitations,
  reason: run.reason ?? null
}));
