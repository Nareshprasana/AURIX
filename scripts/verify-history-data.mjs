// Targeted proof: real historical bars -> buildDataset -> runBacktest.
// Reads LOCAL data only (data/processed/<ver>/backtest-bars.json, gitignored).
// Not part of the committed suite (no local-data dependency in tests).
// Run: `pnpm build && node scripts/verify-history-data.mjs <dataset-version>`
import { readFileSync, existsSync } from 'node:fs';
import { buildDataset } from '../dist/apps/backtest/src/index.js';
import { runBacktest } from '../dist/apps/backtest/src/index.js';
import { FAMILY_PRESETS, TradingCalendar } from '../dist/packages/strategy/src/index.js';

const version = process.argv[2];
if (!version) throw new Error('usage: verify-history-data.mjs <dataset-version>');
const path = `data/processed/${version}/backtest-bars.json`;
if (!existsSync(path)) throw new Error(`missing local proof data: ${path} (run history-fetch/history-build first)`);
const bars = JSON.parse(readFileSync(path, 'utf8'));
console.log(`bars=${bars.length} instruments=${[...new Set(bars.map((b) => b.instrument_id))].join(',')}`);

const dataset = buildDataset({
  id: 'aurix-nse-daily', timeframe: '1D', bars,
  source: 'tej-bazaar', calendar_version: 'cal-weekday-v1'
});
console.log(`dataset=${dataset.id} version=${dataset.version} range=${dataset.range.from_ts}..${dataset.range.to_ts}`);
console.log(`limitations=${JSON.stringify(dataset.limitations)}`);

const conditions = FAMILY_PRESETS['roc-momentum'].build({ n: 1, threshold: 0 });
const universe = [...new Set(bars.map((b) => b.instrument_id))];
const strategy = {
  id: 'proof:roc-real', version: 1, name: 'roc on real NSE bars', description: 'compat proof',
  family: 'momentum', scope: { markets: ['equity'], segments: ['EQ'], timeframes: ['1D'], universe },
  entry_long: conditions.entry_long, entry_short: conditions.entry_short, exit: conditions.exit,
  sizing: { type: 'fixed-qty', qty: 1, max_notional: 1_000_000, max_adv_pct: 100 },
  signal_horizon_bars: 5, required_observations: [], required_data: ['ohlcv'], required_events: [],
  assumptions: ['compat proof only'], cost_model: { brokerage_bps: 0, exchange_bps: 0, taxes_bps: 0, min_cost: 0, per_side: true },
  slippage_model: { kind: 'fixed-bps', base_bps: 0 },
  liquidity: { min_value: 1, min_volume: 1, max_participation: 100, max_adv_pct: 100, max_spread_bps: 10_000 },
  regimes: { supported: [], preferred: [], blocked: [] },
  params: { n: 1, threshold: 0 }, param_bounds: { n: [1, 10], threshold: [0, 1] },
  family_preset: 'roc-momentum', created_at: 1, author: 'verify-history-data',
  provenance: { source: 'verify-history-data', source_type: 'agent', evidence_refs: [] },
  evidence_refs: [], status: 'CANDIDATE'
};
const from = new Date(dataset.range.from_ts).toISOString().slice(0, 10);
const to = new Date(dataset.range.to_ts).toISOString().slice(0, 10);
const run = runBacktest({
  dataset, strategy,
  calendar: TradingCalendar.weekdays(from, to, [], 'cal-weekday-v1'),
  initial_cash: 100_000, dataVersion: dataset.version, generatedAt: Date.now()
});
console.log(`status=${run.status} orders=${run.orders.length} fills=${run.fills.length} trades=${run.trades.length}`);
console.log(`signals=${run.signals?.length ?? 'n/a'} reason=${run.reason ?? 'none'}`);
if (run.signals.length === 0) throw new Error('compat failed: no signals from real bars');
if (run.orders.length > 0) {
  for (const o of run.orders) {
    if (!(o.ts_execute > o.ts_signal)) throw new Error('point-in-time violation: execution before signal');
  }
  console.log('point-in-time: all executions strictly after signal bars');
} else {
  // Deterministic engine rule: entries block on UNKNOWN liquidity (null spread).
  // Zero orders here is CORRECT behavior, not a failure — the engine refuses to
  // invent liquidity. Assert the limitation is recorded, not silent.
  if (!dataset.limitations.some((l) => l.includes('spread'))) {
    throw new Error('compat failed: zero orders without a recorded liquidity limitation');
  }
  console.log('liquidity-gate: entries correctly blocked on UNKNOWN spread (recorded limitation)');
}
console.log(`metrics=${JSON.stringify({ total_return: run.metrics.total_return, trades: run.metrics.trades, max_drawdown: run.metrics.max_drawdown })}`);
console.log('\nHISTORY-BACKTEST COMPAT: ok (integrity proof only, not a profitability claim)');
