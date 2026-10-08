// Backtest gate for the training orchestrator: real bars through the EXISTING
// backtest engine with cost/slippage/liquidity-aware settings. Prints one JSON
// line: {ok, status, orders, fills, trades, max_drawdown_pct, reason}.
// ok=true means the engine ran cleanly with point-in-time discipline (NOT that
// the strategy is profitable — classification accuracy != profitability).
// Usage: node --import ./scripts/aurix-register.mjs scripts/backtest-gate.mjs <bars.json>
import { readFileSync } from 'node:fs';
import { buildDataset } from '../dist/apps/backtest/src/index.js';
import { runBacktest } from '../dist/apps/backtest/src/index.js';
import { FAMILY_PRESETS, TradingCalendar } from '../dist/packages/strategy/src/index.js';

const barsPath = process.argv[2];
if (!barsPath) throw new Error('usage: backtest-gate.mjs <backtest-bars.json>');
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
const run = runBacktest({
  dataset, strategy,
  calendar: TradingCalendar.weekdays(from, to, [], 'cal-weekday-v1'),
  initial_cash: 100_000, dataVersion: dataset.version, generatedAt: Date.now()
});
for (const o of run.orders) {
  if (!(o.ts_execute > o.ts_signal)) {
    console.log(JSON.stringify({ ok: false, reason: 'point-in-time violation' }));
    process.exit(0);
  }
}
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
